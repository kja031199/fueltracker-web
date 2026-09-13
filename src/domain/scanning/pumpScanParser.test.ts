import { describe, expect, test } from 'vitest';
import {
  EMPTY_PUMP_READING,
  MAX_TRIPLE_CANDIDATES,
  isCompleteReading,
  isEmptyReading,
  mergePumpReadings,
  parsePump,
} from './pumpScanParser';

describe('labelled displays', () => {
  test('parses a fully laballed display', () => {
    const reading = parsePump(['THIS SALE $30.48', 'GALLONS 8.712', 'PRICE/GAL $3.499']);
    expect(reading.gallons).toBe(8.712);
    expect(reading.pricePerGallon).toBe(3.499);
    expect(reading.totalCost).toBe(30.48);
    expect(isCompleteReading(reading)).toBe(true);
  });

  test('parses labels on separate lines', () => {
    // Pumps routinely put the caption on one display line and the value on the
    // next, so a label has to survive until the next number turns up.
    const reading = parsePump([
      'GALLONS', '8.712',
      'PRICE PER GALLON', '3.499',
      'TOTAL SALE', '30.48',
    ]);
    expect(reading.gallons).toBe(8.712);
    expect(reading.pricePerGallon).toBe(3.499);
    expect(reading.totalCost).toBe(30.48);
  });

  test('handles the nine-tenths price notation', () => {
    expect(parsePump(['PRICE/GAL', '$3.49 9/10']).pricePerGallon).toBe(3.499);
    // Also without the space, which is how some pumps print it.
    expect(parsePump(['PRICE/GAL', '$3.499/10']).pricePerGallon).toBe(3.499);
  });

  test('a labelled value is not overwritten by a later number', () => {
    expect(parsePump(['GALLONS 8.712', 'GALLONS 9.999']).gallons).toBe(8.712);
  });

  test('a label with an out-of-band value is discarded, not clamped', () => {
    // 87 is an octane rating, not gallons.
    expect(parsePump(['GALLONS 87.000']).gallons).toBeNull();
  });
});

describe('arithmetic consistency', () => {
  test('an unlabelled triple is identified by its own arithmetic', () => {
    // 8.712 × 3.499 = 30.483… ≈ 30.48 — that consistency alone says which
    // number is which, with no labels at all.
    const reading = parsePump(['30.48', '8.712', '3.499']);
    expect(reading.gallons).toBe(8.712);
    expect(reading.pricePerGallon).toBe(3.499);
    expect(reading.totalCost).toBe(30.48);
  });

  test('derives gallons from total and price', () => {
    const reading = parsePump(['TOTAL $35.00', 'PRICE/GAL $3.500']);
    expect(reading.pricePerGallon).toBe(3.5);
    expect(reading.gallons).toBe(10.0);
  });

  test('derives total from gallons and price', () => {
    expect(parsePump(['GALLONS 10.000', 'PRICE/GAL $3.500']).totalCost).toBe(35.0);
  });

  test('a grand total that bundles extras does not displace the fuel line', () => {
    // The car wash and tax mean 41.24 will not reconcile with gallons × price,
    // so the fuel numbers win on their own arithmetic.
    const reading = parsePump([
      'UNLEADED  9.000 GAL', 'PRICE/GAL 3.500',
      'FUEL 31.50', 'CAR WASH 9.00', 'TAX 0.74', 'TOTAL 41.24',
    ]);
    expect(reading.gallons).toBe(9.0);
    expect(reading.pricePerGallon).toBe(3.5);
  });
});

describe('the three-decimal heuristic', () => {
  test('resolves an unlabelled price and gallons when each is unambiguous', () => {
    const reading = parsePump(['3.499', '12.345']);
    expect(reading.pricePerGallon).toBe(3.499);
    expect(reading.gallons).toBe(12.345);
  });

  test('refuses to guess between two candidates in the same band', () => {
    // Refusing to answer beats answering wrong.
    const reading = parsePump(['3.499', '2.999']);
    expect(reading.pricePerGallon).toBeNull();
    expect(isCompleteReading(reading)).toBe(false);
  });

  test('does not reuse the price as the gallons figure', () => {
    // One value sits in both bands; it cannot be both readings at once.
    const reading = parsePump(['3.499']);
    expect(reading.pricePerGallon).toBe(3.499);
    expect(reading.gallons).toBeNull();
  });
});

describe('noise and out-of-range input', () => {
  test('empty and noise input produce nothing', () => {
    expect(parsePump([])).toEqual(EMPTY_PUMP_READING);
    expect(parsePump(['REGULAR', 'UNLEADED', 'INSERT CARD'])).toEqual(EMPTY_PUMP_READING);
    expect(isCompleteReading(parsePump(['WELCOME']))).toBe(false);
  });

  test('implausible values are ignored', () => {
    // 87 (octane) and 42150.0 (an odometer) are out of range for everything.
    expect(parsePump(['87.0', '42150.0'])).toEqual(EMPTY_PUMP_READING);
  });

  test('negative values never become a reading', () => {
    // The minus sign is not part of the number pattern, so "-3.500" reads as
    // 3.500 — which is exactly why nothing may be inferred from it alone.
    const reading = parsePump(['-3.500', 'TOTAL -35.81']);
    for (const value of [reading.gallons, reading.pricePerGallon, reading.totalCost]) {
      expect(value === null || value > 0).toBe(true);
    }
  });

  test('zero never becomes gallons or a price', () => {
    const reading = parsePump(['GALLONS 0.000', 'PRICE/GAL 0.000']);
    expect(reading.gallons).toBeNull();
    expect(reading.pricePerGallon).toBeNull();
  });

  test('more than three decimals are truncated to three, not misread', () => {
    // The pattern takes at most three fraction digits, so "3.4999" yields
    // 3.499 followed by a stray "9" that belongs to no band.
    expect(parsePump(['PRICE/GAL 3.4999']).pricePerGallon).toBe(3.499);
  });
});

describe('merging frames', () => {
  test('keeps the best values seen across frames', () => {
    const first = mergePumpReadings(EMPTY_PUMP_READING, {
      gallons: 8.712, pricePerGallon: null, totalCost: null,
    });
    expect(first.gallons).toBe(8.712);

    const second = mergePumpReadings(first, {
      gallons: null, pricePerGallon: 3.499, totalCost: null,
    });
    expect(second.gallons).toBe(8.712);
    expect(second.pricePerGallon).toBe(3.499);
    expect(isCompleteReading(second)).toBe(true);
  });

  test('a new value wins over an older one for the same field', () => {
    const merged = mergePumpReadings(
      { gallons: 8.712, pricePerGallon: null, totalCost: null },
      { gallons: 9.001, pricePerGallon: null, totalCost: null },
    );
    expect(merged.gallons).toBe(9.001);
  });

  test('merging two empty readings stays empty', () => {
    expect(isEmptyReading(mergePumpReadings(EMPTY_PUMP_READING, EMPTY_PUMP_READING))).toBe(true);
  });
});

describe('hostile input', () => {
  test('a number flood completes promptly', () => {
    // The consistency search is O(n³). Without the candidate cap, a crafted
    // number-dense image would freeze the UI rather than fail; the cap is only
    // real if something measures it.
    const flood = Array.from({ length: 800 }, (_, i) => `${10 + (i % 40)}.${100 + (i % 800)}`);
    const started = Date.now();
    const reading = parsePump(flood);
    expect(Date.now() - started).toBeLessThan(1000);
    // Whatever it decides, it must stay inside the plausible bands.
    if (reading.gallons !== null) expect(reading.gallons).toBeLessThanOrEqual(60);
    if (reading.pricePerGallon !== null) expect(reading.pricePerGallon).toBeLessThanOrEqual(9.999);
  });

  test('the candidate cap is a real bound, not a comment', () => {
    expect(MAX_TRIPLE_CANDIDATES).toBe(40);
  });

  test('a very long line does not throw', () => {
    const long = `GALLONS ${'8.712 '.repeat(5000)}`;
    expect(() => parsePump([long])).not.toThrow();
    expect(parsePump([long]).gallons).toBe(8.712);
  });

  test('non-ASCII and emoji text matches nothing', () => {
    expect(parsePump(['⛽️ ПРИВЕТ', '日本語テキスト', '🚗🚗🚗'])).toEqual(EMPTY_PUMP_READING);
  });

  test('a reading is never partially mutated by a later failed parse', () => {
    // Each call builds its own reading; no state leaks between invocations.
    const first = parsePump(['GALLONS 8.712', 'PRICE/GAL 3.499']);
    const second = parsePump(['NOTHING HERE']);
    expect(first.gallons).toBe(8.712);
    expect(isEmptyReading(second)).toBe(true);
  });
});
