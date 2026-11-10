import { describe, expect, test } from 'vitest';
import {
  EMPTY_PUMP_READING,
  MAX_TRIPLE_CANDIDATES,
  isCompleteReading,
  isEmptyReading,
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

/**
 * The fuel line a warehouse-club receipt prints: "4.092 @ 4.099" — quantity at
 * unit price, both read straight off the paper. Its summary "GALLONS" line was
 * misread on both runs of a real Sam's Club receipt (as 4.099, then 4.045), and
 * a label used to outrank everything, so 4.099 gallons was offered — and passed
 * corroboration, because 4.099 × 4.099 is within 1% of $16.77.
 */
describe('the fuel "@" line', () => {
  // The fuel-relevant lines of that receipt, as OCR returned them.
  const samsClub = (summary: string): string[] => [
    'p 4.092 @ 4.099',
    'UNLEAD ~~ 16.77 0',
    'SUBTOTAL 16.77',
    'TOTAL EN',
    'VISA TEND 16.77',
    'CHANGE DUE 0.00',
    'FUEL SALES SUMMARY',
    summary,
  ];

  test('outranks a summary GALLONS line misread as the price', () => {
    const reading = parsePump(samsClub('GALLONS : 4.099'));
    expect(reading.gallons).toBe(4.092);
    expect(reading.pricePerGallon).toBe(4.099);
    expect(reading.totalCost).toBe(16.77);
  });

  test('outranks a summary GALLONS line misread as another number', () => {
    const reading = parsePump(samsClub('GALLONS : 4.045'));
    expect(reading.gallons).toBe(4.092);
    expect(reading.pricePerGallon).toBe(4.099);
  });

  test('outranks a labelled price too', () => {
    const reading = parsePump(['10.512 @ 3.919', 'PRICE/GAL 3.991', 'TOTAL 41.20']);
    expect(reading.pricePerGallon).toBe(3.919);
    expect(reading.gallons).toBe(10.512);
  });

  test('reads the units and currency receipts print around it', () => {
    for (const line of [
      '10.512 GAL @ $3.919',
      '10.512 GALLONS @ 3.919/GAL',
      '10.512G @ $3.919/G',
      'REGULAR 10.512@3.919 41.20',
      '10.512 @ $3.91 9/10',
    ]) {
      const reading = parsePump([line, 'GALLONS 9.999']);
      expect(reading.gallons, line).toBe(10.512);
      expect(reading.pricePerGallon, line).toBe(3.919);
    }
  });

  test('the same fuel line printed twice is still one fuel line', () => {
    const reading = parsePump(['4.092 @ 4.099', 'GALLONS : 4.099', '4.092 @ 4.099']);
    expect(reading.gallons).toBe(4.092);
  });

  test('two fuel lines that disagree: neither is trusted over the labels', () => {
    // Refusing beats guessing — the old ladder decides, exactly as before.
    const lines = ['4.092 @ 4.099', '5.000 @ 3.999', 'GALLONS 8.712', 'PRICE/GAL 3.499'];
    const reading = parsePump(lines);
    expect(reading.gallons).toBe(8.712);
    expect(reading.pricePerGallon).toBe(3.499);
  });

  test('merchandise lines do not count: whole quantities, cent prices', () => {
    for (const line of ['2 @ 1.99', '1 @ 4.099', '2.00 @ 1.99', '3 @ 4.099 EA', '4.092 @ 4.09']) {
      expect(parsePump([line, 'GALLONS 8.712']).gallons, line).toBe(8.712);
    }
  });

  test('an implausible pair is ignored, not half-used', () => {
    for (const line of ['99.999 @ 4.099', '4.092 @ 0.999', '0.100 @ 4.099', '4.092 @ 12.999']) {
      const reading = parsePump([line, 'GALLONS 8.712', 'PRICE/GAL 3.499']);
      expect(reading.gallons, line).toBe(8.712);
      expect(reading.pricePerGallon, line).toBe(3.499);
    }
  });

  test('a pair cut out of a longer number is not a fuel line', () => {
    // OCR noise that merges digits must not yield a trusted pair from its middle.
    for (const line of ['4.092 @ 4.0995', '8.4.092 @ 4.099', '4.092 @ 4.099.5']) {
      const reading = parsePump([line, 'GALLONS 8.712', 'PRICE/GAL 3.499']);
      expect(reading.gallons, line).toBe(8.712);
      expect(reading.pricePerGallon, line).toBe(3.499);
    }
  });

  test('an "@" with nothing usable either side changes nothing', () => {
    expect(parsePump(['@', '@ @ @', '4.092 @', '@ 4.099', 'EMAIL ME @ HOME'])).toEqual(
      EMPTY_PUMP_READING,
    );
  });

  test('a flood of fuel lines is bounded and refuses to choose', () => {
    const flood = Array.from({ length: 5000 }, (_, i) => `${(1 + (i % 50)).toFixed(3)} @ 3.${String(100 + (i % 800)).slice(0, 3)}`);
    const started = Date.now();
    const reading = parsePump(flood);
    expect(Date.now() - started).toBeLessThan(1000);
    if (reading.gallons !== null) expect(reading.gallons).toBeLessThanOrEqual(60);
    if (reading.pricePerGallon !== null) expect(reading.pricePerGallon).toBeLessThanOrEqual(9.999);
  });
});
