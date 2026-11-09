import { describe, expect, test } from 'vitest';
import {
  canSaveForm,
  draftFromForm,
  editableText,
  emptyFillUpForm,
  formTotalCost,
  odometerLooksWrong,
  parseTypedNumber,
  previousOdometer,
} from './fillUpForm';
import type { FillUpFormState } from './fillUpForm';

const filled = (overrides: Partial<FillUpFormState> = {}): FillUpFormState => ({
  ...emptyFillUpForm(new Date(2025, 0, 15)),
  odometer: 10_000,
  gallons: 10,
  pricePerGallon: 3.5,
  ...overrides,
});

describe('the live total', () => {
  test('multiplies gallons by price', () => {
    expect(formTotalCost({ gallons: 10, pricePerGallon: 3.5 })).toBe(35);
  });

  test('treats a missing field as zero rather than blanking', () => {
    // So the line never flickers between a value and nothing mid-edit.
    expect(formTotalCost({ gallons: null, pricePerGallon: 3.5 })).toBe(0);
    expect(formTotalCost({ gallons: 10, pricePerGallon: null })).toBe(0);
    expect(formTotalCost({ gallons: null, pricePerGallon: null })).toBe(0);
  });
});

describe('what can be saved', () => {
  test('a complete form produces a draft', () => {
    expect(canSaveForm(filled())).toBe(true);
    expect(draftFromForm(filled())?.odometer).toBe(10_000);
  });

  test('an empty form cannot be saved', () => {
    expect(canSaveForm(emptyFillUpForm())).toBe(false);
    expect(draftFromForm(emptyFillUpForm())).toBeNull();
  });

  test('each required field is genuinely required', () => {
    expect(canSaveForm(filled({ odometer: null }))).toBe(false);
    expect(canSaveForm(filled({ gallons: null }))).toBe(false);
    expect(canSaveForm(filled({ pricePerGallon: null }))).toBe(false);
  });

  test('zero and negative values do not count as filled in', () => {
    expect(canSaveForm(filled({ gallons: 0 }))).toBe(false);
    expect(canSaveForm(filled({ odometer: -1 }))).toBe(false);
  });

  test('a non-finite value cannot be saved either', () => {
    // A pasted "Infinity" passes a > 0 check and would poison every statistic.
    expect(canSaveForm(filled({ pricePerGallon: Number.POSITIVE_INFINITY }))).toBe(false);
    expect(canSaveForm(filled({ gallons: Number.NaN }))).toBe(false);
  });

  test('optional fields stay optional', () => {
    const draft = draftFromForm(filled({ station: '', notes: '' }));
    expect(draft).not.toBeNull();
    expect(draft?.station).toBe('');
  });

  test('carries the details through to the draft', () => {
    const draft = draftFromForm(
      filled({ station: 'Shell', notes: 'road trip', fuelGrade: 'Premium', isFullTank: false }),
    );
    expect(draft?.station).toBe('Shell');
    expect(draft?.notes).toBe('road trip');
    expect(draft?.fuelGrade).toBe('Premium');
    expect(draft?.isFullTank).toBe(false);
  });
});

describe('the odometer sanity check', () => {
  test('finds the highest reading already logged', () => {
    expect(previousOdometer([10_000, 10_800, 10_400], false)).toBe(10_800);
  });

  test('is silent while editing', () => {
    // Correcting an old fill-up legitimately has a reading below the latest.
    // Warning about it would teach the reader to ignore the warning.
    expect(previousOdometer([10_000, 10_800], true)).toBeNull();
  });

  test('is silent with no history', () => {
    expect(previousOdometer([], false)).toBeNull();
  });

  test('flags a reading at or below the last one', () => {
    expect(odometerLooksWrong(10_700, 10_800)).toBe(true);
    expect(odometerLooksWrong(10_800, 10_800)).toBe(true);
    expect(odometerLooksWrong(10_900, 10_800)).toBe(false);
  });

  test('says nothing when either side is missing', () => {
    expect(odometerLooksWrong(null, 10_800)).toBe(false);
    expect(odometerLooksWrong(10_000, null)).toBe(false);
  });

  test('is a warning, not a block', () => {
    // The app does not know whether this is a typo, a replaced cluster or a
    // correction, so it says so and still lets the entry be saved.
    const form = filled({ odometer: 9_000 });
    expect(odometerLooksWrong(form.odometer, 10_800)).toBe(true);
    expect(canSaveForm(form)).toBe(true);
  });
});

describe('what was typed, as a number (#93: moved from the form component)', () => {
  test('a number, with the space around it ignored', () => {
    expect(parseTypedNumber('12.5')).toBe(12.5);
    expect(parseTypedNumber(' 12.5 ')).toBe(12.5);
    expect(parseTypedNumber('1e3')).toBe(1000);
    expect(parseTypedNumber('0')).toBe(0);
  });

  test('blank is not entered, not zero', () => {
    expect(parseTypedNumber('')).toBeNull();
    expect(parseTypedNumber('   ')).toBeNull();
  });

  test('nonsense and the non-finite are not entered either, so the draft gate stays the only judge', () => {
    for (const text of ['abc', '12abc', 'NaN', 'Infinity', '-Infinity', '1e400', '3,5']) {
      expect(parseTypedNumber(text), text).toBeNull();
    }
  });

  test('a negative number is passed on — refusing it is the draft’s job, not the parser’s', () => {
    expect(parseTypedNumber('-5')).toBe(-5);
  });
});

describe('a stored value, as text to edit (#93: moved from the form component)', () => {
  const same = (value: number): number => value;

  test('nothing stored is an empty field', () => {
    expect(editableText(null, same)).toBe('');
  });

  test('the conversion is applied, and its long tail cut to the three decimals a pump prints', () => {
    expect(editableText(10, (gallons) => gallons * 3.785411784)).toBe('37.854');
    expect(editableText(3.4999, same)).toBe('3.5');
    expect(editableText(12, same)).toBe('12');
  });
});
