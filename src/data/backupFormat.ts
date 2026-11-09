/**
 * Reading and writing the export formats.
 *
 * ## This one is not a port
 *
 * Every other module here translated working Swift with a test suite attached.
 * Export was **never built** in the iOS app — it is still an open issue there —
 * so there are no assertions to carry across and no reference behaviour to
 * check against. The tests beside this file *are* the specification rather than
 * a translation of one, which is worth knowing before changing anything in it.
 *
 * ## Two formats, two jobs
 *
 * **JSON** is the fidelity format: every field, every row, including tombstones
 * and receipt bytes, and it round-trips exactly. It is what stands between a
 * cleared browser and total loss.
 *
 * **CSV** is the spreadsheet format: one row per fill-up, no vehicles, no
 * receipts. Lossy by construction and useful anyway.
 *
 * Everything here is pure — no store, no DOM, no clock — so the parsing can be
 * tested against hostile input without any of that in the way.
 */

import type { FillUpRecord, Snapshot } from './records';
import { SCHEMA_VERSION } from './records';
import { MAX_RECEIPT_BYTES } from '../domain/fuelEntryDraft';
import { totalCost } from '../domain/models';
import { validateFillUp, validatePending, validateVehicle } from './recordValidation';
import { isRecord } from './guards';

/** Bumped only when the *file* shape changes, not when a record shape does. */
export const BACKUP_FORMAT_VERSION = 1;


export interface BackupFile extends Snapshot {
  readonly format: 'fueltracker-backup';
  readonly formatVersion: number;
  readonly schemaVersion: number;
  /** When the file was written, for a human reading a folder of them. */
  readonly exportedAt: string;
}

// MARK: - Base64 for receipt bytes

/**
 * Receipt bytes as base64.
 *
 * A backup that silently drops photos is a backup that lies, so they travel
 * with the file. A photo is re-encoded to a bounded size when it is attached
 * (`receiptImage.ts`), so it is usually a few hundred kilobytes — and on the
 * way back in, the 4 MB storage ceiling is checked on the base64 *before* it is
 * decoded.
 *
 * Chunked rather than one spread call: `String.fromCharCode(...bytes)` blows the
 * call stack somewhere around a hundred thousand arguments, and a receipt can
 * be four megabytes.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Base64 back to bytes, or `null` if it is not valid base64 — or larger than
 * `maxBytes`.
 *
 * **The bound is checked before decoding, not after.** Four base64 characters
 * carry three bytes, so the decoded size is known from the text length alone,
 * and refusing there means an oversized payload is never allocated. Deciding
 * after `atob` would mean the allocation this guard exists to prevent has
 * already happened — a 400 MB string in a hand-edited backup took the test
 * suite eight seconds to refuse that way, which is the harm in miniature.
 *
 * Unbounded by default, so callers that already know the size stay unchanged.
 */
export function base64ToBytes(
  text: string,
  maxBytes: number = Number.POSITIVE_INFINITY,
): Uint8Array | null {
  if (decodedLengthOf(text) > maxBytes) return null;
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * How many bytes `text` would decode to, from its length alone.
 *
 * An over-estimate by at most two bytes when padding is absent, which is the
 * right direction to be wrong in for a size guard.
 */
function decodedLengthOf(text: string): number {
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  return Math.floor((text.length / 4) * 3) - padding;
}

// MARK: - JSON

export function toJsonBackup(snapshot: Snapshot, exportedAt: Date = new Date()): string {
  const file = {
    format: 'fueltracker-backup',
    formatVersion: BACKUP_FORMAT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: exportedAt.toISOString(),
    vehicles: snapshot.vehicles,
    fillUps: snapshot.fillUps.map((record) => ({
      ...record,
      receiptImageData:
        record.receiptImageData === null ? null : bytesToBase64(record.receiptImageData),
    })),
    pendingFillUps: snapshot.pendingFillUps.map((record) => ({
      ...record,
      receiptImageData:
        record.receiptImageData === null ? null : bytesToBase64(record.receiptImageData),
    })),
  };
  return JSON.stringify(file, null, 2);
}

export interface ParseResult<T> {
  readonly value: T | null;
  /** Why it could not be read, in words a person can act on. */
  readonly error: string | null;
  /** Rows dropped because they were not usable, with a reason each. */
  readonly skipped: readonly string[];
}

/** The object to read fields from, or `null`. */
const asObject = (value: unknown): Record<string, unknown> | null => (isRecord(value) ? value : null);

/**
 * A row from a file, with its receipt turned from base64 into bytes — the one
 * thing about a row that differs between a file and the account. Everything
 * else is decoded by the same functions that read the account
 * (`recordValidation.ts`), so the two cannot drift apart again (#54).
 *
 * The receipt is bounded **before** it is decoded: four characters carry three
 * bytes, so the size is known from the text alone, and deciding afterwards
 * would mean the allocation the bound exists to prevent had already happened.
 * An unreadable or oversized photo is dropped and reported; the row is kept.
 */
function withReceiptBytes(value: unknown, skipped: string[]): unknown {
  const row = asObject(value);
  if (row === null) return value;
  const encoded = row['receiptImageData'];
  if (typeof encoded !== 'string' || encoded === '') return { ...row, receiptImageData: null };
  const bytes = base64ToBytes(encoded, MAX_RECEIPT_BYTES);
  if (bytes === null) {
    const id = typeof row['id'] === 'string' ? row['id'] : 'a row';
    skipped.push(`${id}: the receipt photo was unreadable or too large, so the entry was kept without it`);
    return { ...row, receiptImageData: null };
  }
  return { ...row, receiptImageData: bytes };
}

/** Runs one decoder over a list, keeping what decodes and reporting the rest. */
function decodeAll<T>(rows: unknown, decode: (value: unknown) => T | string, skipped: string[]): T[] {
  const out: T[] = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const result = decode(row);
    if (typeof result === 'string') skipped.push(result);
    else out.push(result);
  }
  return out;
}

/**
 * Reads a backup file.
 *
 * Nothing here trusts the input. It is a file a person chose: it may be
 * truncated, hand-edited, written by an older version, or not a backup at all.
 * A row that cannot be read is skipped **and reported**, so an import never
 * half-succeeds in silence.
 */
export function parseJsonBackup(text: string): ParseResult<Snapshot> {
  const skipped: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { value: null, error: 'That file is not valid JSON.', skipped };
  }

  const file = asObject(parsed);
  if (file === null) {
    return { value: null, error: 'That file is not a FuelTracker backup.', skipped };
  }
  if (file['format'] !== 'fueltracker-backup') {
    return {
      value: null,
      error: 'That file is not a FuelTracker backup — it has no backup marker.',
      skipped,
    };
  }
  const rawVersion = file['formatVersion'];
  const version = typeof rawVersion === 'number' && Number.isFinite(rawVersion) ? rawVersion : null;
  if (version !== null && version > BACKUP_FORMAT_VERSION) {
    return {
      value: null,
      error: `That backup was written by a newer version (format ${version}). Update first, then import it.`,
      skipped,
    };
  }

  // A row a newer build wrote may carry fields this one does not know (#86).
  // Imported, the next push would send it back without them: the downgrade
  // sync already refuses (`partitionBySchema`). Set aside **before** it is
  // validated, so a newer shape is counted as newer rather than as damaged.
  let tooNew = 0;
  const thisVersion = (rows: unknown): unknown[] => {
    if (!Array.isArray(rows)) return [];
    const readable = rows.filter((row) => !fromNewerBuild(row));
    tooNew += rows.length - readable.length;
    return readable;
  };

  // The same decoders the account is read with: one policy for both doors.
  const vehicles = decodeAll(thisVersion(file['vehicles']), validateVehicle, skipped);
  const fillUps = decodeAll(
    thisVersion(file['fillUps']).map((row) => withReceiptBytes(row, skipped)),
    validateFillUp,
    skipped,
  );
  const pendingFillUps = decodeAll(
    thisVersion(file['pendingFillUps']).map((row) => withReceiptBytes(row, skipped)),
    validatePending,
    skipped,
  );
  if (tooNew > 0) {
    skipped.push(
      `${tooNew === 1 ? '1 row was' : `${tooNew} rows were`} written by a newer version of FuelTracker and ` +
        'skipped. Update the app, then import this file again.',
    );
  }

  return { value: { vehicles, fillUps, pendingFillUps }, error: null, skipped };
}

/** A row stamped with a schema this build does not know (#86). */
function fromNewerBuild(row: unknown): boolean {
  const version = asObject(row)?.['schemaVersion'];
  return typeof version === 'number' && version > SCHEMA_VERSION;
}

// MARK: - CSV

/**
 * The columns, in order.
 *
 * **Units are named in the header and the values are canonical** — miles, US
 * gallons, price per US gallon. Exporting in whatever the reader currently has
 * selected would make the file's meaning depend on a setting that is not in the
 * file, and a column headed `odometer` could then mean either thing. This way a
 * metric reader gets miles, which is the awkward part of the trade, but nobody
 * can misread the number.
 */
export const CSV_COLUMNS = [
  'id',
  'vehicle_id',
  'date_iso',
  'odometer_miles',
  'gallons',
  'price_per_gallon',
  'total_cost',
  'full_tank',
  'missed_previous',
  'fuel_grade',
  'station',
  'notes',
] as const;

/**
 * Characters a spreadsheet reads as the beginning of a formula.
 *
 * Any number of leading apostrophes is part of the pattern so that the guard
 * escapes **itself**: text that already starts with `'=` gets another
 * apostrophe, and the reader takes exactly one off again. Without that, the
 * escape would not be reversible and an export/import cycle would quietly
 * rewrite somebody's data — a worse bug than the one this prevents.
 */
const CSV_FORMULA_START = /^'*[=+\-@\t\r]/;

/** The same shape, once guarded: at least one apostrophe before the trigger. */
const CSV_GUARDED_START = /^'+[=+\-@\t\r]/;

/**
 * Stops a spreadsheet executing the contents of a cell.
 *
 * RFC 4180 quoting below makes the file *parse*; it does nothing about what
 * Excel, LibreOffice or Google Sheets *evaluate*. A cell beginning with `=`,
 * `+`, `-`, `@`, a tab or a carriage return is a formula to all three, and
 * quoting does not help — `"=1+1"` is still evaluated. The payloads that matter
 * are `=HYPERLINK(…&A2)`, which exfiltrates the neighbouring cell when clicked,
 * and the `=cmd|'/c …'!A0` family, which offers to run a command.
 *
 * Worth guarding even though most of this text is self-authored, because some
 * of it is not: `parseReceipt` lifts a station name out of OCR'd receipt text,
 * an imported file can carry anything, and a `pendingFillUp` carries a station
 * and notes written by somebody else entirely.
 *
 * A leading apostrophe is the conventional fix: spreadsheets read it as "this
 * cell is text" and do not display it.
 */
function guardCsvCell(value: string): string {
  return CSV_FORMULA_START.test(value) ? `'${value}` : value;
}

/**
 * Undoes `guardCsvCell`, so an export and a re-import agree.
 *
 * Applied to **every** cell on the way in, not only the text ones: the guard is
 * blind to what a column means, so a guarded number has to lose its apostrophe
 * before `Number()` sees it. It also honours the same convention from other
 * tools, since prefixing an apostrophe on export is common.
 */
export function unguardCsvCell(value: string): string {
  return CSV_GUARDED_START.test(value) ? value.slice(1) : value;
}

/**
 * RFC 4180 quoting, after the formula guard.
 *
 * In that order: the guard can add a character, and whether the result needs
 * quoting depends on the whole string.
 */
function csvCell(value: string): string {
  const guarded = guardCsvCell(value);
  return /[",\r\n]/.test(guarded) ? `"${guarded.split('"').join('""')}"` : guarded;
}

export function toCsv(records: readonly FillUpRecord[]): string {
  const rows = [CSV_COLUMNS.join(',')];
  for (const record of records) {
    rows.push(
      [
        record.id,
        record.vehicleId,
        new Date(record.date).toISOString(),
        String(record.odometer),
        String(record.gallons),
        String(record.pricePerGallon),
        String(totalCost(record)),
        record.isFullTank ? 'yes' : 'no',
        record.missedPreviousFillUp ? 'yes' : 'no',
        record.fuelGrade,
        record.station,
        record.notes,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  // A trailing newline, so appending in a shell or diffing behaves.
  return `${rows.join('\n')}\n`;
}

/**
 * Splits CSV text into rows of cells.
 *
 * Written by hand rather than split on commas, because a station name with a
 * comma in it and a note containing a newline are both ordinary — and a naive
 * split turns either into a silently corrupted row. Handles CRLF, which is what
 * a spreadsheet on Windows writes.
 */
export function splitCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      // Consume the LF of a CRLF pair rather than emitting a blank row.
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/**
 * Reads a CSV back into fill-up records.
 *
 * Columns are matched **by header name, not by position**, so a file with its
 * columns reordered or with extra columns added by a spreadsheet still imports.
 * A missing required column is an error rather than a silent zero.
 */
export function parseCsv(text: string): ParseResult<FillUpRecord[]> {
  const skipped: string[] = [];
  const rows = splitCsv(text).filter((row) => row.some((cell) => cell.trim() !== ''));
  const header = rows.shift();
  if (header === undefined) {
    return { value: null, error: 'That file is empty.', skipped };
  }

  const index = new Map(header.map((name, position) => [name.trim().toLowerCase(), position]));
  const required = ['id', 'vehicle_id', 'date_iso', 'odometer_miles', 'gallons', 'price_per_gallon'];
  const missing = required.filter((name) => !index.has(name));
  if (missing.length > 0) {
    return {
      value: null,
      error: `That CSV is missing required columns: ${missing.join(', ')}.`,
      skipped,
    };
  }

  const cell = (row: string[], name: string): string => {
    const position = index.get(name);
    if (position === undefined) return '';
    // Unguarded after trimming, not before: a cell guarded because it began
    // with a tab would otherwise have that tab trimmed away and the value
    // would not survive the round trip.
    return unguardCsvCell((row[position] ?? '').trim());
  };

  const records: FillUpRecord[] = [];
  for (const [position, row] of rows.entries()) {
    const line = position + 2;
    const date = new Date(cell(row, 'date_iso'));
    if (Number.isNaN(date.getTime())) {
      skipped.push(`row ${line} has an unreadable date`);
      continue;
    }
    // A spreadsheet row becomes the same shape the account and a JSON backup
    // hold, and is decoded by the same function (#54) — so its id, vehicle,
    // numbers and text meet exactly the rules every other door applies. A
    // spreadsheet is a very easy place for an id to pick up a slash, and one
    // unstorable id costs the account its sync (#26).
    const decoded = validateFillUp({
      id: cell(row, 'id'),
      updatedAt: date.getTime(),
      deletedAt: null,
      schemaVersion: SCHEMA_VERSION,
      vehicleId: cell(row, 'vehicle_id'),
      date: date.getTime(),
      odometer: Number(cell(row, 'odometer_miles')),
      gallons: Number(cell(row, 'gallons')),
      pricePerGallon: Number(cell(row, 'price_per_gallon')),
      isFullTank: cell(row, 'full_tank').toLowerCase() !== 'no',
      missedPreviousFillUp: cell(row, 'missed_previous').toLowerCase() === 'yes',
      fuelGrade: cell(row, 'fuel_grade'),
      station: cell(row, 'station'),
      notes: cell(row, 'notes'),
      latitude: null,
      longitude: null,
      receiptImageData: null,
    });
    if (typeof decoded === 'string') {
      skipped.push(`row ${line}: ${decoded}`);
      continue;
    }
    records.push(decoded);
  }
  return { value: records, error: null, skipped };
}

/**
 * A file somebody chose to import, read by its name (#93): `.csv` as fill-ups
 * alone, anything else as a JSON backup. The one place that decides, so a
 * screen hands over the file and gets a snapshot or a reason back.
 */
export function parseBackupFile(name: string, text: string): ParseResult<Snapshot> {
  if (!name.toLowerCase().endsWith('.csv')) return parseJsonBackup(text);
  const parsed = parseCsv(text);
  const value = parsed.value === null ? null : { vehicles: [], fillUps: parsed.value, pendingFillUps: [] };
  return { ...parsed, value };
}
