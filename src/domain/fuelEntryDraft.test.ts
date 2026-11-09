import { describe, expect, test } from 'vitest';
import { FUEL_GRADES, fuelGradeFromRaw } from './fuelGrade';
import { MAX_RECEIPT_BYTES, makeFuelEntryDraft } from './fuelEntryDraft';
import { totalCost } from './models';
import { TEXT_LIMITS } from './textLimits';

const valid = () => ({
  date: new Date('2026-07-19T12:00:00Z'),
  odometer: 42150,
  gallons: 8.712,
  pricePerGallon: 3.499,
});

describe('the write chokepoint rejects bad measurements', () => {
  test('a complete valid input produces a draft that preserves its values', () => {
    const d = makeFuelEntryDraft(valid())!;
    expect(d).not.toBeNull();
    expect(d.odometer).toBe(42150);
    expect(d.gallons).toBe(8.712);
    expect(d.pricePerGallon).toBe(3.499);
  });

  test.each(['odometer', 'gallons', 'pricePerGallon'] as const)(
    'rejects missing, zero and negative %s',
    (field) => {
      for (const bad of [null, undefined, 0, -1, -0.0001]) {
        expect(makeFuelEntryDraft({ ...valid(), [field]: bad })).toBeNull();
      }
    },
  );

  test.each(['odometer', 'gallons', 'pricePerGallon'] as const)(
    'rejects non-finite %s — NaN fails > 0, but +Infinity would not',
    (field) => {
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        expect(makeFuelEntryDraft({ ...valid(), [field]: bad })).toBeNull();
      }
    },
  );

  test('defaults match the Swift initialiser', () => {
    const d = makeFuelEntryDraft(valid())!;
    expect(d.isFullTank).toBe(true);
    expect(d.missedPreviousFillUp).toBe(false);
    expect(d.fuelGrade).toBe('Regular');
    expect(d.station).toBe('');
    expect(d.notes).toBe('');
    expect(d.latitude).toBeNull();
    expect(d.longitude).toBeNull();
    expect(d.receiptImageData).toBeNull();
  });

  test('total cost is derived, never stored', () => {
    const d = makeFuelEntryDraft({ ...valid(), gallons: 10, pricePerGallon: 3.5 })!;
    expect(totalCost(d)).toBeCloseTo(35, 10);
  });
});

describe('receipt ceiling is defence in depth', () => {
  test('a normal blob is kept', () => {
    const receipt = new Uint8Array(200 * 1024);
    const d = makeFuelEntryDraft({ ...valid(), receiptImageData: receipt })!;
    expect(d.receiptImageData).toBe(receipt);
  });

  test('a blob exactly at the ceiling is kept', () => {
    const d = makeFuelEntryDraft({
      ...valid(),
      receiptImageData: new Uint8Array(MAX_RECEIPT_BYTES),
    })!;
    expect(d.receiptImageData).not.toBeNull();
  });

  test('one byte over drops the photo but KEEPS the fill-up', () => {
    const d = makeFuelEntryDraft({
      ...valid(),
      receiptImageData: new Uint8Array(MAX_RECEIPT_BYTES + 1),
    });
    expect(d).not.toBeNull();
    expect(d!.receiptImageData).toBeNull();
    // Losing the photo is recoverable; losing the entry is not.
    expect(d!.odometer).toBe(42150);
  });

  test('an empty blob is kept as-is rather than treated as absent', () => {
    const d = makeFuelEntryDraft({ ...valid(), receiptImageData: new Uint8Array(0) })!;
    expect(d.receiptImageData).not.toBeNull();
    expect(d.receiptImageData!.byteLength).toBe(0);
  });
});

describe('fuel grade', () => {
  test('round-trips every known grade', () => {
    for (const g of FUEL_GRADES) expect(fuelGradeFromRaw(g)).toBe(g);
  });

  test('an unrecognised raw value degrades to Other rather than throwing', () => {
    expect(fuelGradeFromRaw('Hydrogen')).toBe('Other');
    expect(fuelGradeFromRaw('')).toBe('Other');
    expect(fuelGradeFromRaw('regular')).toBe('Other'); // case-sensitive, like Swift's raw value
  });

  test('Regular is first, so it is the natural default in a picker', () => {
    expect(FUEL_GRADES[0]).toBe('Regular');
  });
});

describe('text is bounded at the gate (#50)', () => {
  const base = { date: new Date(2026, 0, 1), odometer: 10_000, gallons: 10, pricePerGallon: 3 };

  test('a station one past the limit is shortened, and the fill-up still saves', () => {
    // Shortened rather than rejected: losing an odometer reading over a long
    // station name would be the worse outcome — the rule `recordValidation`
    // already applies to text arriving from the account.
    const draft = makeFuelEntryDraft({ ...base, station: 's'.repeat(TEXT_LIMITS.station + 1) });
    expect(draft?.station).toHaveLength(TEXT_LIMITS.station);
  });

  test('notes one past the limit are shortened', () => {
    const draft = makeFuelEntryDraft({ ...base, notes: 'n'.repeat(TEXT_LIMITS.notes + 1) });
    expect(draft?.notes).toHaveLength(TEXT_LIMITS.notes);
  });

  test('text within the limit is kept exactly', () => {
    const draft = makeFuelEntryDraft({ ...base, station: 'Shell', notes: 'n'.repeat(TEXT_LIMITS.notes) });
    expect(draft?.station).toBe('Shell');
    expect(draft?.notes).toHaveLength(TEXT_LIMITS.notes);
  });
});
