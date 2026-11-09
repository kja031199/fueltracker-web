import { describe, expect, test } from 'vitest';
import { MAX_RECEIPT_BYTES, makeFuelEntryDraft, type FuelEntryDraft } from '../domain/fuelEntryDraft';
import { TEXT_LIMITS } from '../domain/textLimits';
import { SCHEMA_VERSION } from './records';
import { draftFromRecord, fillUpFromDraft, formFromRecord, pendingFromDraft } from './recordMapping';
import { draftFromForm, emptyFillUpForm } from '../domain/fillUpForm';

/**
 * A draft and a record, in each direction, written once (#91).
 *
 * The same field-by-field copy used to be written out four times in the store
 * and once more in the import, and the copies had started to differ. These
 * pin the one mapping each way, and that a round trip changes nothing.
 */

function draft(overrides: Partial<Parameters<typeof makeFuelEntryDraft>[0]> = {}): FuelEntryDraft {
  const made = makeFuelEntryDraft({
    date: new Date(1_700_000_000_000),
    odometer: 10_000,
    gallons: 10.5,
    pricePerGallon: 3.499,
    isFullTank: false,
    missedPreviousFillUp: true,
    fuelGrade: 'Premium',
    station: 'Shell',
    notes: 'windy',
    latitude: 51.5,
    longitude: -0.12,
    receiptImageData: new Uint8Array([1, 2, 3]),
    ...overrides,
  });
  if (made === null) throw new Error('fixture draft failed validation');
  return made;
}

const FILL_UP_META = { id: 'f1', vehicleId: 'v1', updatedAt: 500, enteredBy: 'uid-a' } as const;
const PENDING_META = { id: 'p1', vehicleId: 'v1', updatedAt: 500, submittedAt: 400, submitterName: 'Sam' } as const;

describe('a draft becomes a fill-up', () => {
  test('carrying every field of the draft, and the sync fields it is given', () => {
    const record = fillUpFromDraft(draft(), FILL_UP_META);
    expect(record).toEqual({
      id: 'f1',
      updatedAt: 500,
      deletedAt: null,
      schemaVersion: SCHEMA_VERSION,
      vehicleId: 'v1',
      enteredBy: 'uid-a',
      date: 1_700_000_000_000,
      odometer: 10_000,
      gallons: 10.5,
      pricePerGallon: 3.499,
      isFullTank: false,
      missedPreviousFillUp: true,
      fuelGrade: 'Premium',
      station: 'Shell',
      notes: 'windy',
      latitude: 51.5,
      longitude: -0.12,
      receiptImageData: new Uint8Array([1, 2, 3]),
    });
  });

  test('and back, unchanged', () => {
    const original = draft();
    expect(draftFromRecord(fillUpFromDraft(original, FILL_UP_META))).toEqual(original);
  });

  test('a draft with nothing optional set round-trips too', () => {
    const plain = makeFuelEntryDraft({ date: new Date(1_700_000_000_000), odometer: 1, gallons: 1, pricePerGallon: 1 });
    if (plain === null) throw new Error('fixture draft failed validation');
    expect(draftFromRecord(fillUpFromDraft(plain, FILL_UP_META))).toEqual(plain);
  });
});

describe('a draft becomes a submission', () => {
  test('carrying every field of the draft a submission has, and who sent it', () => {
    const record = pendingFromDraft(draft(), PENDING_META);
    expect(record).toEqual({
      id: 'p1',
      updatedAt: 500,
      deletedAt: null,
      schemaVersion: SCHEMA_VERSION,
      vehicleId: 'v1',
      submittedAt: 400,
      submitterName: 'Sam',
      date: 1_700_000_000_000,
      odometer: 10_000,
      gallons: 10.5,
      pricePerGallon: 3.499,
      isFullTank: false,
      fuelGrade: 'Premium',
      station: 'Shell',
      notes: 'windy',
      latitude: 51.5,
      longitude: -0.12,
      receiptImageData: new Uint8Array([1, 2, 3]),
    });
  });

  test('and back — everything but "missed the previous fill-up", which a submission never carries', () => {
    const original = draft();
    expect(draftFromRecord(pendingFromDraft(original, PENDING_META))).toEqual({ ...original, missedPreviousFillUp: false });
    const notMissed = draft({ missedPreviousFillUp: false });
    expect(draftFromRecord(pendingFromDraft(notMissed, PENDING_META))).toEqual(notMissed);
  });

  test('the sender’s name is cut to what the account accepts', () => {
    const record = pendingFromDraft(draft(), { ...PENDING_META, submitterName: 'S'.repeat(500) });
    expect(record.submitterName).toHaveLength(TEXT_LIMITS.submitterName);
  });
});

describe('a record becomes a draft only if it would pass the gate', () => {
  test.each([
    ['no gallons', { gallons: 0 }],
    ['negative odometer', { odometer: -1 }],
    ['a price that is not a number', { pricePerGallon: Number.NaN }],
    ['infinite gallons', { gallons: Number.POSITIVE_INFINITY }],
  ])('%s → null', (_name, broken) => {
    const record = { ...fillUpFromDraft(draft(), FILL_UP_META), ...broken };
    expect(draftFromRecord(record)).toBeNull();
    expect(draftFromRecord({ ...pendingFromDraft(draft(), PENDING_META), ...broken })).toBeNull();
  });

  test('text and a photo the gate would refuse are cut and dropped, as at the gate', () => {
    const record = {
      ...fillUpFromDraft(draft(), FILL_UP_META),
      notes: 'n'.repeat(TEXT_LIMITS.notes + 10),
      receiptImageData: new Uint8Array(MAX_RECEIPT_BYTES + 1),
    };
    const back = draftFromRecord(record);
    expect(back?.notes).toHaveLength(TEXT_LIMITS.notes);
    expect(back?.receiptImageData).toBeNull();
  });
});

describe('a stored fill-up, as the form edits it (#93: moved from the form component)', () => {
  test('fills every field the form has, and nothing else', () => {
    const form = formFromRecord(fillUpFromDraft(draft(), FILL_UP_META));
    expect(Object.keys(form).sort()).toEqual(Object.keys(emptyFillUpForm()).sort());
  });

  test('opening a fill-up and saving it untouched saves what it was', () => {
    const record = fillUpFromDraft(draft(), FILL_UP_META);
    expect(draftFromForm(formFromRecord(record))).toEqual(draftFromRecord(record));
  });

  test('the date comes back as a date, and the photo as the same bytes', () => {
    const record = fillUpFromDraft(draft(), FILL_UP_META);
    const form = formFromRecord(record);
    expect(form.date).toBeInstanceOf(Date);
    expect(form.date.getTime()).toBe(record.date);
    expect(form.receiptImageData).toBe(record.receiptImageData);
  });
});
