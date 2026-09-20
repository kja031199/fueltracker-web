import { describe, expect, test } from 'vitest';
import { isCorroborated, numbersIn, reconciles } from './corroboration';
import type { PumpReading } from './pumpScanParser';

const reading = (overrides: Partial<PumpReading> = {}): PumpReading => ({
  gallons: 10.234,
  pricePerGallon: 3.499,
  totalCost: 35.81,
  ...overrides,
});

describe('reconciles', () => {
  test('accepts a triple that multiplies out', () => {
    expect(reconciles(10.234, 3.499, 35.81)).toBe(true);
  });

  test('allows a cent of rounding, as a printed receipt does', () => {
    expect(reconciles(10, 3.5, 35.04)).toBe(true);
    expect(reconciles(10, 3.5, 34.96)).toBe(true);
  });

  test('scales the tolerance with the total', () => {
    // A cent is right on a $35 fill; on a $300 truck fill, 1% is.
    expect(reconciles(85, 3.5, 299.0)).toBe(true);
    expect(reconciles(85, 3.5, 250.0)).toBe(false);
  });

  test('rejects a triple that does not', () => {
    expect(reconciles(16.234, 3.499, 35.81)).toBe(false);
  });
});

/** Everything on a well-read receipt, as the OCR would have seen it. */
const SEEN = [10.234, 3.499, 35.81];

describe('numbersIn', () => {
  test('collects the decimal numbers the OCR actually saw', () => {
    expect(numbersIn(['GALLONS 10.234', 'PRICE/GAL $3.499', 'FUEL TOTAL $35.81']))
      .toEqual([10.234, 3.499, 35.81]);
  });

  test('ignores integers, which the parser never reads as measurements', () => {
    expect(numbersIn(['PUMP 04', 'REGULAR'])).toEqual([]);
  });
});

describe('isCorroborated', () => {
  test('accepts three values that agree', () => {
    expect(isCorroborated(reading(), SEEN)).toBe(true);
  });

  test('declines when any of the three is missing', () => {
    // A value the parser derived cannot corroborate the others — it was
    // computed to agree with them.
    expect(isCorroborated(reading({ gallons: null }), SEEN)).toBe(false);
    expect(isCorroborated(reading({ pricePerGallon: null }), SEEN)).toBe(false);
    expect(isCorroborated(reading({ totalCost: null }), SEEN)).toBe(false);
  });

  test('declines the misreads that motivated it', () => {
    // Measured failures from degraded receipt photos: both sit inside the
    // plausible gallons range, so nothing downstream would question them.
    expect(isCorroborated(reading({ gallons: 16.234 }), [16.234, 3.499, 35.81])).toBe(false);
    expect(isCorroborated(reading({ gallons: 53.499 }), [53.499, 3.499, 35.81])).toBe(false);
  });

  test('declines a value the parser derived rather than read', () => {
    // The hole this rule had at first. Given 16.234 gallons and a $35.81
    // total, the pump parser computes $2.206 a gallon — and that multiplies
    // back out perfectly, because it was calculated to. Checking only the
    // arithmetic would wave through exactly the misread being guarded against.
    const derived = { gallons: 16.234, pricePerGallon: 2.206, totalCost: 35.81 };
    expect(reconciles(16.234, 2.206, 35.81)).toBe(true);
    expect(isCorroborated(derived, [16.234, 35.81])).toBe(false);
  });

  test('cannot be fooled by a non-finite value', () => {
    expect(isCorroborated(reading({ gallons: Number.NaN }), SEEN)).toBe(false);
    expect(isCorroborated(reading({ pricePerGallon: Number.POSITIVE_INFINITY }), SEEN)).toBe(false);
    expect(isCorroborated(reading({ totalCost: Number.NaN }), SEEN)).toBe(false);
  });

  test('a single dropped digit in the price still slips through', () => {
    // Honest about the limit. When the OCR reads "3.49" rather than "3.499",
    // the misread value is what the text contains, so the read-check passes —
    // and 10.234 x 3.49 is $35.72 against a printed $35.81, inside the
    // tolerance a genuine rounding would need. This is the one measured
    // failure the rule does not catch; it is a tenth of a cent, and the reader
    // still sees the number before saving.
    expect(isCorroborated(reading({ pricePerGallon: 3.49 }), [10.234, 3.49, 35.81])).toBe(true);
  });
});
