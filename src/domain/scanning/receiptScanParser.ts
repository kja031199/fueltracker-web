/**
 * Parses OCR text lines from a fuel receipt, ported from
 * `Shared/Scanning/ReceiptScanParser.swift`.
 *
 * The gallons / price / total triple is delegated to the pump parser, whose
 * label and arithmetic-consistency logic already isolates a receipt's fuel line
 * — and naturally rejects a grand total bundling tax, a car wash or a loyalty
 * discount, because gallons × price will not reconcile with it. On top of that,
 * this parser adds the two things only a receipt carries:
 *
 * - the printed **purchase date and time**, in the many shapes receipts use.
 *   The photo's own EXIF date is merely when it was *snapped*, which can be
 *   days later;
 * - the **station brand**, matched against known retailers so the result is a
 *   clean name rather than a random line of address text.
 */

import type { PumpReading } from './pumpScanParser';
import { isEmptyReading, parsePump } from './pumpScanParser';

export interface ReceiptReading {
  readonly reading: PumpReading;
  readonly purchaseDate: Date | null;
  readonly stationName: string | null;
}

export function isEmptyReceipt(receipt: ReceiptReading): boolean {
  return (
    isEmptyReading(receipt.reading) &&
    receipt.purchaseDate === null &&
    receipt.stationName === null
  );
}

/**
 * Distinctive brand words, **most-specific first**, paired with a clean display
 * name. Order is load-bearing: "EXXONMOBIL" has to be tried before "EXXON", and
 * "PHILLIPS 66" before "PHILLIPS", or the shorter needle wins and the name is
 * wrong.
 *
 * Every needle is alphabetic, so none can collide with a dollar amount or a
 * pump number, and matches are boundary-checked so a brand cannot hide inside a
 * longer word — ARCO within "MARCOS", BP within "SUBPAR".
 */
const BRANDS: readonly (readonly [needle: string, name: string])[] = [
  ['EXXONMOBIL', 'ExxonMobil'],
  ['EXXON', 'Exxon'],
  ['MOBIL', 'Mobil'],
  ['SHELL', 'Shell'],
  ['CHEVRON', 'Chevron'],
  ['TEXACO', 'Texaco'],
  ['MARATHON', 'Marathon'],
  ['SUNOCO', 'Sunoco'],
  ['VALERO', 'Valero'],
  ['PHILLIPS 66', 'Phillips 66'],
  ['PHILLIPS', 'Phillips 66'],
  ['CONOCO', 'Conoco'],
  ['CITGO', 'Citgo'],
  ['SINCLAIR', 'Sinclair'],
  ['ARCO', 'ARCO'],
  ['QUIKTRIP', 'QuikTrip'],
  ['RACETRAC', 'RaceTrac'],
  ['CIRCLE K', 'Circle K'],
  ['SPEEDWAY', 'Speedway'],
  ['KWIK TRIP', 'Kwik Trip'],
  ['KWIK STAR', 'Kwik Star'],
  ['KUM & GO', 'Kum & Go'],
  ['CASEY', "Casey's"],
  ['BUC-EE', "Buc-ee's"],
  ['BUCEE', "Buc-ee's"],
  ["LOVE'S", "Love's"],
  ['FLYING J', 'Flying J'],
  ['PILOT', 'Pilot'],
  ['WAWA', 'Wawa'],
  ['SHEETZ', 'Sheetz'],
  ['MAVERIK', 'Maverik'],
  ['ROYAL FARMS', 'Royal Farms'],
  ['MURPHY', 'Murphy USA'],
  ['HOLIDAY', 'Holiday'],
  ['CENEX', 'Cenex'],
  ['GETGO', 'GetGo'],
  ['IRVING', 'Irving'],
  ['PETRO-CANADA', 'Petro-Canada'],
  ['ESSO', 'Esso'],
  ['COSTCO', 'Costco'],
  ["SAM'S CLUB", "Sam's Club"],
  ['SAMS CLUB', "Sam's Club"],
  ['MEIJER', 'Meijer'],
  ['BP', 'BP'],
];

const LETTER = /[A-Za-z]/;

/**
 * True if `needle` appears in `haystack` bounded by non-letters.
 *
 * Not a `\b` regex: several needles contain `&`, `'` and `-`, where `\b`'s
 * notion of a word boundary is not the one wanted. This scans instead, and —
 * importantly — **keeps looking after a rejected match**, so "SUBPAR BP" still
 * finds the standalone BP later on the line.
 */
function boundaryContains(haystack: string, needle: string): boolean {
  let searchStart = 0;
  for (;;) {
    const index = haystack.indexOf(needle, searchStart);
    if (index === -1) return false;
    const before = index === 0 || !LETTER.test(haystack[index - 1]!);
    const afterIndex = index + needle.length;
    const after = afterIndex === haystack.length || !LETTER.test(haystack[afterIndex]!);
    if (before && after) return true;
    searchStart = index + 1;
  }
}

/**
 * The brand from the topmost line that names one — the merchant header usually
 * sits above the address, so "EXXON" then "NEAR SHELL PLAZA" is an Exxon.
 */
function station(lines: readonly string[]): string | null {
  for (const line of lines) {
    for (const [needle, name] of BRANDS) {
      if (boundaryContains(line, needle)) return name;
    }
  }
  return null;
}

interface YMD {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function makeYMD(year: number | null, month: number | null, day: number | null): YMD | null {
  if (year === null || month === null || day === null) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  let resolved = year;
  if (resolved < 100) resolved += 2000; // "26" → 2026
  if (resolved < 1990 || resolved > 2100) return null;
  return { year: resolved, month, day };
}

const MONTHS: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

function monthNumber(name: string): number | null {
  return MONTHS[name.slice(0, 3)] ?? null;
}

function toInt(text: string | undefined): number | null {
  if (text === undefined) return null;
  const value = Number.parseInt(text, 10);
  return Number.isNaN(value) ? null : value;
}

function dateIn(line: string): YMD | null {
  // ISO first: 2026-07-19 / 2026.07.19
  const iso = /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/.exec(line);
  if (iso !== null) return makeYMD(toInt(iso[1]), toInt(iso[2]), toInt(iso[3]));

  // Month name: JUL 19, 2026 / JULY 19 2026 / SEP 3RD 2026
  const named = /\b([A-Z]{3,9})\.?\s+(\d{1,2})(?:ST|ND|RD|TH)?,?\s+(\d{2,4})\b/.exec(line);
  if (named !== null) {
    const month = monthNumber(named[1]!);
    if (month !== null) return makeYMD(toInt(named[3]), month, toInt(named[2]));
  }

  // Numeric: 07/19/2026, 7/19/26, 19-07-2026.
  const numeric = /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/.exec(line);
  if (numeric !== null) {
    const a = toInt(numeric[1]);
    const b = toInt(numeric[2]);
    const year = toInt(numeric[3]);
    if (a === null || b === null || year === null) return null;
    // A first field over 12 can only be the day (day/month ordering);
    // otherwise assume US month/day.
    const dayFirst = a > 12 && b <= 12;
    return makeYMD(year, dayFirst ? b : a, dayFirst ? a : b);
  }
  return null;
}

interface HMS {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function timeIn(line: string): HMS | null {
  const match = /\b(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?\b/.exec(line);
  if (match === null) return null;
  let hour = toInt(match[1]);
  const minute = toInt(match[2]);
  if (hour === null || minute === null || minute < 0 || minute > 59) return null;

  const second = toInt(match[3]);
  if (second !== null && (second < 0 || second > 59)) return null;

  const meridiem = match[4];
  if (meridiem !== undefined) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === 'PM' && hour < 12) hour += 12;
    if (meridiem === 'AM' && hour === 12) hour = 0;
  }
  if (hour < 0 || hour > 23) return null;
  return { hour, minute, second: second ?? 0 };
}

const DAY_MS = 86_400 * 1000;
/** Deliberately 365-day years, matching the Swift's own arithmetic. */
const FORTY_YEARS_MS = 40 * 365 * DAY_MS;

function purchaseDate(lines: readonly string[], referenceDate: Date): Date | null {
  let ymd: YMD | null = null;
  for (const line of lines) {
    const match = dateIn(line);
    if (match !== null) {
      ymd = match;
      break;
    }
  }
  if (ymd === null) return null;

  let time: HMS = { hour: 0, minute: 0, second: 0 };
  for (const line of lines) {
    const match = timeIn(line);
    if (match !== null) {
      time = match;
      break;
    }
  }

  // Local time throughout, as everywhere else in the port.
  const date = new Date(ymd.year, ymd.month - 1, ymd.day, time.hour, time.minute, time.second);
  if (Number.isNaN(date.getTime())) return null;

  // A receipt is a record of the past. Reject anything meaningfully in the
  // future (allowing a day of clock skew) or absurdly old — both are the
  // signature of a misread number rather than a real purchase.
  if (date.getTime() > referenceDate.getTime() + DAY_MS) return null;
  if (date.getTime() < referenceDate.getTime() - FORTY_YEARS_MS) return null;

  // Reject impossible calendar days — Feb 30 — which the Date constructor would
  // otherwise silently roll forward into the next month, exactly as Calendar
  // does upstream.
  if (
    date.getFullYear() !== ymd.year ||
    date.getMonth() + 1 !== ymd.month ||
    date.getDate() !== ymd.day
  ) {
    return null;
  }
  return date;
}

export function parseReceipt(
  rawLines: readonly string[],
  referenceDate: Date = new Date(),
): ReceiptReading {
  // The pump parser does its own uppercasing and `9/10` normalisation, so it
  // takes the raw lines; the brand and date scans want them folded first.
  const reading = parsePump(rawLines);
  const lines = rawLines.map((line) => line.toUpperCase());
  return {
    reading,
    stationName: station(lines),
    purchaseDate: purchaseDate(lines, referenceDate),
  };
}
