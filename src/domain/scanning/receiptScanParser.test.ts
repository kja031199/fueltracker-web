import { describe, expect, test } from 'vitest';
import { EMPTY_PUMP_READING } from './pumpScanParser';
import { isEmptyReceipt, parseReceipt } from './receiptScanParser';

/**
 * A fixed "today" so receipt dates are deterministically in the past however
 * long from now the suite runs. Chosen to sit after every past-dated fixture
 * below but before the December date used to exercise future rejection.
 */
const REFERENCE = new Date(2026, 9, 15); // 15 October 2026, local

const parse = (lines: string[]) => parseReceipt(lines, REFERENCE);

const ymd = (date: Date): [number, number, number] => [
  date.getFullYear(),
  date.getMonth() + 1,
  date.getDate(),
];

const hm = (date: Date): [number, number] => [date.getHours(), date.getMinutes()];

describe('realistic receipts', () => {
  test('parses a full Shell receipt', () => {
    const receipt = parse([
      'SHELL',
      '1234 MAIN ST',
      'AUSTIN TX 78701',
      '07/19/2026  14:35:07',
      'PUMP 04',
      'REGULAR',
      'GALLONS      10.234',
      'PRICE/GAL    $3.499',
      'FUEL TOTAL   $35.81',
    ]);
    expect(receipt.reading.gallons).toBe(10.234);
    expect(receipt.reading.pricePerGallon).toBe(3.499);
    expect(receipt.stationName).toBe('Shell');
    expect(ymd(receipt.purchaseDate!)).toEqual([2026, 7, 19]);
    expect(hm(receipt.purchaseDate!)).toEqual([14, 35]);
  });

  test('parses a one-line fuel entry by arithmetic', () => {
    // No clean labels — the gallons × price ≈ total consistency, delegated to
    // the pump parser, recovers all three.
    const receipt = parse(['CHEVRON', '10.234 GAL @ 3.499  35.81']);
    expect(receipt.reading.gallons).toBe(10.234);
    expect(receipt.reading.pricePerGallon).toBe(3.499);
    expect(receipt.stationName).toBe('Chevron');
  });
});

describe('date formats', () => {
  test('parses a US numeric date', () => {
    expect(ymd(parse(['07/19/2026']).purchaseDate!)).toEqual([2026, 7, 19]);
  });

  test('parses a two-digit year', () => {
    expect(ymd(parse(['07/19/26']).purchaseDate!)).toEqual([2026, 7, 19]);
  });

  test('parses an ISO date', () => {
    expect(ymd(parse(['2026-07-19']).purchaseDate!)).toEqual([2026, 7, 19]);
    expect(ymd(parse(['2026.07.19']).purchaseDate!)).toEqual([2026, 7, 19]);
  });

  test('parses month-name dates', () => {
    expect(ymd(parse(['JUL 19, 2026']).purchaseDate!)).toEqual([2026, 7, 19]);
    expect(ymd(parse(['JULY 19 2026']).purchaseDate!)).toEqual([2026, 7, 19]);
    expect(ymd(parse(['SEP 3RD 2026']).purchaseDate!)).toEqual([2026, 9, 3]);
  });

  test('disambiguates day-first when the first field exceeds twelve', () => {
    // 19 cannot be a month, so 19/07 must be day/month rather than month/day.
    expect(ymd(parse(['19/07/2026']).purchaseDate!)).toEqual([2026, 7, 19]);
  });

  test('an ambiguous pair is read as US month/day', () => {
    // Both fields are ≤ 12, so there is nothing to disambiguate on — and the
    // parser is US-tuned by design.
    expect(ymd(parse(['07/08/2026']).purchaseDate!)).toEqual([2026, 7, 8]);
  });

  test('the first date on the receipt wins', () => {
    expect(ymd(parse(['07/19/2026', '08/01/2026']).purchaseDate!)).toEqual([2026, 7, 19]);
  });
});

describe('times', () => {
  test('parses twelve-hour time with a meridiem', () => {
    expect(hm(parse(['07/19/2026', '02:35 PM']).purchaseDate!)).toEqual([14, 35]);
    expect(hm(parse(['07/19/2026', '12:05 AM']).purchaseDate!)).toEqual([0, 5]);
  });

  test('parses twenty-four-hour time with seconds', () => {
    expect(hm(parse(['07/19/2026', '23:07:42']).purchaseDate!)).toEqual([23, 7]);
    expect(parse(['07/19/2026', '23:07:42']).purchaseDate!.getSeconds()).toBe(42);
  });

  test('parses noon and afternoon meridiem times', () => {
    // 12 PM stays 12 (noon); afternoon hours add twelve.
    expect(hm(parse(['07/19/2026', '12:30 PM']).purchaseDate!)).toEqual([12, 30]);
    expect(hm(parse(['07/19/2026', '01:15 PM']).purchaseDate!)).toEqual([13, 15]);
  });

  test('a time without a date is ignored', () => {
    // A time alone cannot anchor a day, so there is no purchase date at all.
    expect(parse(['SHELL', '14:35']).purchaseDate).toBeNull();
  });

  test('an out-of-range time leaves the date at midnight', () => {
    const receipt = parse(['07/19/2026', '25:99']);
    expect(ymd(receipt.purchaseDate!)).toEqual([2026, 7, 19]);
    expect(hm(receipt.purchaseDate!)).toEqual([0, 0]);
  });

  test('an out-of-range second is rejected rather than rolled over', () => {
    // 61 seconds would otherwise push the minute forward by one.
    expect(hm(parse(['07/19/2026', '14:35:61']).purchaseDate!)).toEqual([0, 0]);
  });

  test('a thirteen-hour meridiem time is rejected', () => {
    expect(hm(parse(['07/19/2026', '13:15 PM']).purchaseDate!)).toEqual([0, 0]);
  });
});

describe('station brands', () => {
  test('matches a multi-word brand', () => {
    expect(parse(['CIRCLE K #4021', '07/19/2026']).stationName).toBe('Circle K');
  });

  test('matches brands with an apostrophe or hyphen', () => {
    expect(parse(["BUC-EE'S #52"]).stationName).toBe("Buc-ee's");
    expect(parse(["LOVE'S TRAVEL STOP"]).stationName).toBe("Love's");
    expect(parse(["SAM'S CLUB"]).stationName).toBe("Sam's Club");
  });

  test('matches a two-letter brand only at a word boundary', () => {
    expect(parse(['BP', '07/19/2026']).stationName).toBe('BP');
    expect(parse(['BP #1180']).stationName).toBe('BP');
    // "BP" buried inside a word is not the brand.
    expect(parse(['SUBPAR SERVICE CENTER']).stationName).toBeNull();
  });

  test('ignores a brand hidden inside another word', () => {
    expect(parse(['MARCOS PIZZA', '555-123-4567']).stationName).toBeNull();
  });

  test('finds a brand after a false boundary match earlier in the line', () => {
    // "BP" hides inside "SUBPAR" first; the scan must keep looking and find the
    // standalone brand later on the same line rather than giving up.
    expect(parse(['SUBPAR BP STATION']).stationName).toBe('BP');
  });

  test('returns the topmost brand line', () => {
    expect(parse(['EXXON', 'NEAR SHELL PLAZA']).stationName).toBe('Exxon');
  });

  test('prefers the more specific needle when both match', () => {
    // Ordering in the table is load-bearing: EXXONMOBIL must be tried before
    // EXXON, and PHILLIPS 66 before PHILLIPS.
    expect(parse(['EXXONMOBIL']).stationName).toBe('ExxonMobil');
    expect(parse(['PHILLIPS 66']).stationName).toBe('Phillips 66');
  });

  test('is case-insensitive on the input', () => {
    expect(parse(['shell', '07/19/2026']).stationName).toBe('Shell');
  });

  test('a receipt with no known brand has a null station', () => {
    expect(parse(["JOE'S GAS N GO", '07/19/2026']).stationName).toBeNull();
  });
});

describe('hostile and abnormal input', () => {
  test('rejects a future date', () => {
    // A receipt cannot be from the future; nulling it lets the caller fall back
    // to the photo's own capture date.
    expect(parse(['12/25/2026']).purchaseDate).toBeNull();
  });

  test('accepts a date within a day of the reference, for clock skew', () => {
    expect(ymd(parse(['10/15/2026']).purchaseDate!)).toEqual([2026, 10, 15]);
    expect(ymd(parse(['10/16/2026']).purchaseDate!)).toEqual([2026, 10, 16]);
  });

  test('rejects an absurdly old date via the year range', () => {
    // Two guards bound the past: a 1990-2100 year range, and a forty-year
    // window measured back from the reference. At today's reference dates the
    // YEAR RANGE is the binding one — forty 365-day years before October 2026
    // reaches back to late 1986, so everything the year range admits is also
    // inside the window. The window only starts to bite after about 2030.
    expect(parse(['01/01/1989']).purchaseDate).toBeNull();
    expect(ymd(parse(['01/01/1990']).purchaseDate!)).toEqual([1990, 1, 1]);
  });

  test('the forty-year window bites when the reference is far enough ahead', () => {
    // Pins the second guard directly rather than assuming it works, by moving
    // the reference instead of the receipt.
    const far = new Date(2060, 0, 1);
    expect(parseReceipt(['01/01/2000'], far).purchaseDate).toBeNull();
    expect(parseReceipt(['01/01/2030'], far).purchaseDate).not.toBeNull();
  });

  test('rejects impossible calendar dates', () => {
    expect(parse(['13/40/2026']).purchaseDate).toBeNull(); // month 13, day 40
    expect(parse(['02/30/2026']).purchaseDate).toBeNull(); // Feb 30 never exists
    expect(parse(['02/29/2026']).purchaseDate).toBeNull(); // 2026 is not a leap year
    expect(ymd(parse(['02/29/2024']).purchaseDate!)).toEqual([2024, 2, 29]); // but 2024 is
  });

  test('does not read a phone number or a ZIP+4 as a date', () => {
    expect(parse(['PHONE 555-123-4567']).purchaseDate).toBeNull();
    expect(parse(['AUSTIN TX 78701-1234']).purchaseDate).toBeNull();
  });

  test('a car wash and tax lines do not corrupt the fuel numbers', () => {
    const receipt = parse([
      'CHEVRON',
      '08/02/2026',
      'UNLEADED  9.000 GAL',
      'PRICE/GAL 3.500',
      'FUEL      31.50',
      'CAR WASH   9.00',
      'TAX        0.74',
      'TOTAL     41.24',
    ]);
    expect(receipt.reading.gallons).toBe(9.0);
    expect(receipt.reading.pricePerGallon).toBe(3.5);
  });

  test('noise and empty input produce an empty reading', () => {
    expect(isEmptyReceipt(parse([]))).toBe(true);
    expect(isEmptyReceipt(parse(['THANK YOU', 'COME AGAIN', 'CASHIER: 07']))).toBe(true);
  });

  test('implausible numbers do not become fuel', () => {
    // An odometer-sized number and an octane rating are outside every band.
    expect(parse(['ODOMETER 42150.0', 'OCTANE 87.0']).reading).toEqual(EMPTY_PUMP_READING);
  });

  test('negative and garbage values do not throw or fabricate fuel', () => {
    const receipt = parse(['-3.500', 'TOTAL -35.81', 'PUMP #0000', '999999.999']);
    for (const value of [receipt.reading.gallons, receipt.reading.pricePerGallon]) {
      expect(value === null || value > 0).toBe(true);
    }
  });

  test('a very long receipt does not throw', () => {
    const long = ['SHELL', '07/19/2026', ...Array.from({ length: 5000 }, (_, i) => `ITEM ${i}`)];
    expect(() => parse(long)).not.toThrow();
    expect(parse(long).stationName).toBe('Shell');
  });

  test('non-ASCII and emoji text matches nothing', () => {
    const receipt = parse(['⛽️ ЗАПРАВКА', 'ガソリン', '🧾']);
    expect(isEmptyReceipt(receipt)).toBe(true);
  });

  test('defaults its reference date to now rather than throwing', () => {
    // The default argument is the live clock; a past-dated receipt must still
    // parse without the caller supplying a reference.
    expect(parseReceipt(['SHELL', '01/02/2020']).purchaseDate).not.toBeNull();
  });
});
