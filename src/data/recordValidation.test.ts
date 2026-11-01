import { describe, expect, it } from 'vitest';
import { MAX_RECEIPT_BYTES } from '../domain/fuelEntryDraft';
import {
  MAX_NAME_LENGTH,
  MAX_NOTES_LENGTH,
  validateFillUp,
  validatePending,
  validateSnapshot,
  validateVehicle,
} from './recordValidation';

/**
 * What arrives from the account is untrusted, and these are the cases that
 * matter. The rule under test is the split: structural problems reject the row,
 * cosmetic ones repair the field.
 */

const VEHICLE = {
  id: 'v1',
  updatedAt: 100,
  deletedAt: null,
  schemaVersion: 1,
  name: 'Civic',
  make: 'Honda',
  model: 'Civic',
  year: 2019,
  createdAt: 100,
};

const FILL_UP = {
  id: 'f1',
  updatedAt: 100,
  deletedAt: null,
  schemaVersion: 1,
  vehicleId: 'v1',
  date: 1_700_000_000_000,
  odometer: 10_000,
  gallons: 10,
  pricePerGallon: 3.5,
  isFullTank: true,
  missedPreviousFillUp: false,
  fuelGrade: 'Regular',
  station: 'Shell',
  notes: '',
  latitude: null,
  longitude: null,
  receiptImageData: null,
};

// Deliberately not spread from FILL_UP: a submission has no
// `missedPreviousFillUp`, and copying one in would make this fixture describe a
// record shape that does not exist.
const { missedPreviousFillUp: _unused, ...FILL_UP_WITHOUT_MISSED } = FILL_UP;
const PENDING = {
  ...FILL_UP_WITHOUT_MISSED,
  id: 'p1',
  submittedAt: 90,
  submitterName: 'Sam',
};

describe('a well-formed record passes through unchanged', () => {
  it('keeps a vehicle', () => {
    expect(validateVehicle(VEHICLE)).toEqual(VEHICLE);
  });

  it('keeps a fill-up', () => {
    expect(validateFillUp(FILL_UP)).toEqual(FILL_UP);
  });

  it('keeps a submission', () => {
    expect(validatePending(PENDING)).toEqual(PENDING);
  });
});

describe('structural problems reject the row', () => {
  it.each([
    ['not an object', 'just a string'],
    ['null', null],
    ['an array', []],
    ['a number', 42],
  ])('refuses %s', (_label, value) => {
    expect(typeof validateFillUp(value)).toBe('string');
  });

  it.each([
    ['a missing id', { ...FILL_UP, id: undefined }],
    ['an empty id', { ...FILL_UP, id: '' }],
    ['a non-string id', { ...FILL_UP, id: 7 }],
    ['an id longer than any uuid', { ...FILL_UP, id: 'x'.repeat(500) }],
    // #26: these three reach `doc(db, …, id)` and break the whole push batch
    // — one throws in the SDK, the others are refused by the server.
    ['an id containing a slash', { ...FILL_UP, id: 'a/b' }],
    ['an id Firestore reserves', { ...FILL_UP, id: '__proto__' }],
    ['an id that is a path traversal', { ...FILL_UP, id: '..' }],
    ['a non-numeric updatedAt', { ...FILL_UP, updatedAt: 'yesterday' }],
    ['a NaN updatedAt', { ...FILL_UP, updatedAt: Number.NaN }],
    ['an infinite updatedAt', { ...FILL_UP, updatedAt: Number.POSITIVE_INFINITY }],
    ['a deletedAt that is neither null nor a number', { ...FILL_UP, deletedAt: 'no' }],
    ['a non-numeric schemaVersion', { ...FILL_UP, schemaVersion: '1' }],
    ['a missing vehicleId', { ...FILL_UP, vehicleId: undefined }],
    ['an object vehicleId', { ...FILL_UP, vehicleId: { id: 'v1' } }],
    ['a string date', { ...FILL_UP, date: 'yesterday' }],
    ['a string odometer', { ...FILL_UP, odometer: '10000' }],
    ['NaN gallons', { ...FILL_UP, gallons: Number.NaN }],
    ['an infinite price', { ...FILL_UP, pricePerGallon: Number.POSITIVE_INFINITY }],
  ])('refuses %s', (_label, value) => {
    const result = validateFillUp(value);
    expect(typeof result).toBe('string');
  });

  it('says what was wrong, for a count the reader can see', () => {
    expect(validateFillUp({ ...FILL_UP, odometer: null })).toContain('odometer');
  });

  it('refuses a vehicle whose id cannot be stored', () => {
    expect(typeof validateVehicle({ ...VEHICLE, id: 'a/b' })).toBe('string');
  });

  it('refuses a submission whose id cannot be stored', () => {
    expect(typeof validatePending({ ...PENDING, id: '__name__' })).toBe('string');
  });

  it('keeps the rest of the account when one id is unusable', () => {
    // The rule this file exists for, applied to ids: one bad document must not
    // cost the other nine hundred.
    const result = validateSnapshot({
      vehicles: [VEHICLE],
      fillUps: [FILL_UP, { ...FILL_UP, id: 'a/b' }, { ...FILL_UP, id: 'f3' }],
      pendingFillUps: [],
    });
    expect(result.snapshot.fillUps).toHaveLength(2);
    expect(result.rejected).toHaveLength(1);
  });

  it('refuses a vehicle with a non-numeric createdAt', () => {
    expect(typeof validateVehicle({ ...VEHICLE, createdAt: 'then' })).toBe('string');
  });

  it('refuses a submission with no submittedAt', () => {
    expect(typeof validatePending({ ...PENDING, submittedAt: undefined })).toBe('string');
  });
});

describe('cosmetic problems repair the field', () => {
  it('truncates an essay in the notes rather than losing the fill-up', () => {
    // The row carries an odometer reading that the whole MPG chain depends on.
    // Dropping it because of its notes would be the worse outcome.
    const result = validateFillUp({ ...FILL_UP, notes: 'n'.repeat(MAX_NOTES_LENGTH + 500) });
    expect(typeof result).not.toBe('string');
    if (typeof result === 'string') return;
    expect(result.notes).toHaveLength(MAX_NOTES_LENGTH);
    expect(result.odometer).toBe(10_000);
  });

  it('truncates an oversized station name', () => {
    const result = validateFillUp({ ...FILL_UP, station: 's'.repeat(MAX_NAME_LENGTH + 1) });
    if (typeof result === 'string') throw new Error(result);
    expect(result.station).toHaveLength(MAX_NAME_LENGTH);
  });

  it('turns a non-string label into an empty one, not "[object Object]"', () => {
    // String(value) on an object stores text that looks like real data, which
    // is worse than storing nothing.
    const result = validateFillUp({ ...FILL_UP, station: { name: 'Shell' } });
    if (typeof result === 'string') throw new Error(result);
    expect(result.station).toBe('');
  });

  it('falls back to Other for an unrecognised fuel grade', () => {
    const result = validateFillUp({ ...FILL_UP, fuelGrade: 'Rocket Fuel' });
    if (typeof result === 'string') throw new Error(result);
    expect(result.fuelGrade).toBe('Other');
  });

  it('treats a non-boolean full-tank flag as false rather than truthy', () => {
    // `isFullTank: "no"` is truthy in JavaScript. Accepting it as true would
    // silently change how every segment after it is computed.
    const result = validateFillUp({ ...FILL_UP, isFullTank: 'no' });
    if (typeof result === 'string') throw new Error(result);
    expect(result.isFullTank).toBe(false);
  });

  it('drops a coordinate that is not a finite number', () => {
    const result = validateFillUp({ ...FILL_UP, latitude: 'north', longitude: Number.NaN });
    if (typeof result === 'string') throw new Error(result);
    expect(result.latitude).toBeNull();
    expect(result.longitude).toBeNull();
  });

  it('drops a receipt that is not bytes', () => {
    const result = validateFillUp({ ...FILL_UP, receiptImageData: 'a picture' });
    if (typeof result === 'string') throw new Error(result);
    expect(result.receiptImageData).toBeNull();
  });

  it('drops a receipt larger than any write path allows, keeping the row', () => {
    // Firestore's 1 MiB document cap means this cannot arrive through sync
    // today, so this is defence in depth — but "every path that admits a
    // receipt applies the same bound" is a rule worth holding, rather than
    // "the bound applies except where another system happens to cap it".
    const result = validateFillUp({
      ...FILL_UP,
      receiptImageData: new Uint8Array(MAX_RECEIPT_BYTES + 1),
    });
    if (typeof result === 'string') throw new Error(result);
    expect(result.receiptImageData).toBeNull();
    expect(result.odometer).toBe(10_000);
  });

  it('keeps a receipt of exactly the maximum size', () => {
    const result = validateFillUp({
      ...FILL_UP,
      receiptImageData: new Uint8Array(MAX_RECEIPT_BYTES),
    });
    if (typeof result === 'string') throw new Error(result);
    expect(result.receiptImageData).toHaveLength(MAX_RECEIPT_BYTES);
  });

  it('keeps real receipt bytes', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const result = validateFillUp({ ...FILL_UP, receiptImageData: bytes });
    if (typeof result === 'string') throw new Error(result);
    expect(result.receiptImageData).toEqual(bytes);
  });

  it('treats an empty byte array as no receipt', () => {
    const result = validateFillUp({ ...FILL_UP, receiptImageData: new Uint8Array() });
    if (typeof result === 'string') throw new Error(result);
    expect(result.receiptImageData).toBeNull();
  });

  it.each([
    ['a year before cars', 1300],
    ['a year far in the future', 9999],
    ['a non-numeric year', 'nineteen'],
  ])('zeroes %s', (_label, year) => {
    const result = validateVehicle({ ...VEHICLE, year });
    if (typeof result === 'string') throw new Error(result);
    expect(result.year).toBe(0);
  });

  it('ignores unknown extra fields instead of failing', () => {
    // A document written by a newer build may carry fields this one does not
    // know. Dropping them is right; refusing the row would make every forward
    // schema change a data outage.
    const result = validateFillUp({ ...FILL_UP, somethingNew: 'value' });
    expect(typeof result).not.toBe('string');
    expect(result).not.toHaveProperty('somethingNew');
  });
});

describe('tombstones', () => {
  it('accepts one with no usable measurements', () => {
    // A tombstone records that something was deleted; it has no odometer to
    // validate, which is exactly why importBackup skips the draft gate for one.
    const result = validateFillUp({
      id: 'f1',
      updatedAt: 200,
      deletedAt: 200,
      schemaVersion: 1,
      vehicleId: 'v1',
    });
    expect(typeof result).not.toBe('string');
    if (typeof result === 'string') return;
    expect(result.deletedAt).toBe(200);
  });

  it('still needs an id and a vehicle', () => {
    expect(typeof validateFillUp({ updatedAt: 1, deletedAt: 1, schemaVersion: 1 })).toBe('string');
  });
});

describe('validateSnapshot', () => {
  it('keeps the good rows and counts the bad ones', () => {
    const result = validateSnapshot({
      vehicles: [VEHICLE, { ...VEHICLE, id: '' }],
      fillUps: [FILL_UP, { ...FILL_UP, id: 'f2', gallons: 'ten' }, { ...FILL_UP, id: 'f3' }],
      pendingFillUps: [],
    });

    expect(result.snapshot.vehicles).toHaveLength(1);
    expect(result.snapshot.fillUps).toHaveLength(2);
    expect(result.rejected).toHaveLength(2);
  });

  it('survives empty collections', () => {
    const result = validateSnapshot({ vehicles: [], fillUps: [], pendingFillUps: [] });
    expect(result.rejected).toEqual([]);
    expect(result.snapshot.fillUps).toEqual([]);
  });

  it('does not let one unusable document cost the others', () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ ...FILL_UP, id: `f${i}` }));
    const result = validateSnapshot({
      vehicles: [],
      fillUps: [...rows, 'not a document'],
      pendingFillUps: [],
    });
    expect(result.snapshot.fillUps).toHaveLength(50);
    expect(result.rejected).toHaveLength(1);
  });
});
