import { describe, expect, test } from 'vitest';
import { parseCsv, parseJsonBackup, toCsv } from './backupFormat';
import { validateSnapshot } from './recordValidation';
import { SCHEMA_VERSION, type FillUpRecord } from './records';

/**
 * A restored file and the account read a row the same way (#54).
 *
 * They used to be two decoders with two policies. The file path took any
 * length of text, read `isFullTank: "no"` as true, treated a garbled
 * `deletedAt` as a live row, kept a 99999 model year, defaulted a missing
 * `updatedAt` to zero and quietly dropped a submission with no vehicle. The
 * account path did none of those. One of the differences was a way into the
 * lockout fixed in #50.
 *
 * Each case below goes through both doors and must come out identical — the
 * same records, and the same number of rows refused.
 */
const sync = { updatedAt: 500, deletedAt: null, schemaVersion: SCHEMA_VERSION };
const VEHICLE = { id: 'v1', ...sync, name: 'Car', make: 'Honda', model: 'Civic', year: 2020, createdAt: 500 };
const FILL_UP = {
  id: 'f1',
  ...sync,
  vehicleId: 'v1',
  date: 1_700_000_000_000,
  odometer: 10_000,
  gallons: 10,
  pricePerGallon: 3,
  isFullTank: true,
  missedPreviousFillUp: false,
  fuelGrade: 'Regular',
  station: 'Shell',
  notes: '',
  latitude: null,
  longitude: null,
  receiptImageData: null,
  enteredBy: null,
};
const PENDING = {
  id: 'p1',
  ...sync,
  vehicleId: 'v1',
  submittedAt: 500,
  submitterName: 'Sam',
  date: 1_700_000_000_000,
  odometer: 10_000,
  gallons: 10,
  pricePerGallon: 3,
  isFullTank: true,
  fuelGrade: 'Regular',
  station: '',
  notes: '',
  latitude: null,
  longitude: null,
  receiptImageData: null,
};

function bothWays(raw: { vehicles?: unknown[]; fillUps?: unknown[]; pendingFillUps?: unknown[] }) {
  const collections = {
    vehicles: raw.vehicles ?? [],
    fillUps: raw.fillUps ?? [],
    pendingFillUps: raw.pendingFillUps ?? [],
  };
  const file = parseJsonBackup(JSON.stringify({ format: 'fueltracker-backup', formatVersion: 1, ...collections }));
  const account = validateSnapshot(collections);
  return { file, account };
}

describe('a file and the account decode a row identically', () => {
  test.each([
    ['notes longer than any account accepts', { fillUps: [{ ...FILL_UP, notes: 'n'.repeat(5000) }] }],
    ['a station name longer than the limit', { fillUps: [{ ...FILL_UP, station: 's'.repeat(300) }] }],
    ['a full-tank flag that is a string', { fillUps: [{ ...FILL_UP, isFullTank: 'no' }] }],
    ['a deletion date that is not a date', { fillUps: [{ ...FILL_UP, deletedAt: 'yesterday' }] }],
    ['a model year nobody drove in', { vehicles: [{ ...VEHICLE, year: 99_999 }] }],
    ['a row with no updatedAt', { vehicles: [{ ...VEHICLE, updatedAt: undefined }] }],
    ['a vehicle with no createdAt', { vehicles: [{ ...VEHICLE, createdAt: 'then' }] }],
    ['a measurement that is a word', { fillUps: [{ ...FILL_UP, gallons: 'lots' }] }],
    ['a coordinate that is not a number', { fillUps: [{ ...FILL_UP, latitude: 'north' }] }],
    ['a submission with no vehicle', { pendingFillUps: [{ ...PENDING, vehicleId: '' }] }],
    ['a submission with no submittedAt', { pendingFillUps: [{ ...PENDING, submittedAt: undefined }] }],
    ['an unknown fuel grade', { fillUps: [{ ...FILL_UP, fuelGrade: 'Nitro' }] }],
    ['a name that is not text', { vehicles: [{ ...VEHICLE, name: { first: 'Car' } }] }],
  ])('%s', (_label, raw) => {
    const { file, account } = bothWays(raw);
    expect(file.error).toBeNull();
    expect(file.value).toEqual(account.snapshot);
    expect(file.skipped.length).toBe(account.rejected.length);
  });

  test('a well-formed file still restores every row unchanged', () => {
    const { file } = bothWays({ vehicles: [VEHICLE], fillUps: [FILL_UP], pendingFillUps: [PENDING] });
    expect(file.value).toEqual({ vehicles: [VEHICLE], fillUps: [FILL_UP], pendingFillUps: [PENDING] });
    expect(file.skipped).toEqual([]);
  });
});

describe('a spreadsheet row meets the same rules', () => {
  // CSV is the third door, and the easiest to edit by hand.
  test('notes longer than the account accepts are shortened, not refused', () => {
    const csv = toCsv([{ ...(FILL_UP as FillUpRecord), notes: 'n'.repeat(5000) }]);
    const result = parseCsv(csv);
    expect(result.value?.[0]?.notes).toHaveLength(4000);
    expect(result.skipped).toEqual([]);
  });

  test('a measurement that is not a number is refused, by line and by field', () => {
    const csv = toCsv([FILL_UP as FillUpRecord]).replace(/,10,3,/, ',lots,3,');
    const result = parseCsv(csv);
    expect(result.value).toEqual([]);
    expect(result.skipped.join(' ')).toMatch(/row 2: .*gallons is not a number/);
  });
});
