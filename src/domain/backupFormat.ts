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

import type { FillUpRecord, PendingFillUpRecord, VehicleRecord } from '../data/records';
import { SCHEMA_VERSION } from '../data/records';
import { FUEL_GRADES } from './fuelGrade';
import type { FuelGrade } from './fuelGrade';

/** Bumped only when the *file* shape changes, not when a record shape does. */
export const BACKUP_FORMAT_VERSION = 1;

export interface BackupSnapshot {
  readonly vehicles: readonly VehicleRecord[];
  readonly fillUps: readonly FillUpRecord[];
  readonly pendingFillUps: readonly PendingFillUpRecord[];
}

export interface BackupFile extends BackupSnapshot {
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
 * with the file. They are `null` on every row today — image intake is a later
 * phase — so this costs nothing now and is correct once it does not.
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

/** Base64 back to bytes, or `null` if it is not valid base64. */
export function base64ToBytes(text: string): Uint8Array | null {
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

// MARK: - JSON

export function toJsonBackup(snapshot: BackupSnapshot, exportedAt: Date = new Date()): string {
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function grade(value: unknown): FuelGrade {
  return (FUEL_GRADES as readonly string[]).includes(str(value)) ? (value as FuelGrade) : 'Other';
}

function receipt(value: unknown): Uint8Array | null {
  return typeof value === 'string' && value !== '' ? base64ToBytes(value) : null;
}

/**
 * Sync fields, repaired rather than trusted.
 *
 * An id is the one thing that cannot be invented — without it a row has no
 * identity and merging is impossible — so a row without one is rejected. The
 * rest are defaulted, because a file hand-edited to drop `updatedAt` should
 * still restore rather than fail wholesale.
 */
function syncFields(
  row: Record<string, unknown>,
): { id: string; updatedAt: number; deletedAt: number | null; schemaVersion: number } | null {
  const id = str(row['id']);
  if (id === '') return null;
  return {
    id,
    updatedAt: num(row['updatedAt']) ?? 0,
    deletedAt: num(row['deletedAt']),
    schemaVersion: num(row['schemaVersion']) ?? SCHEMA_VERSION,
  };
}

function parseVehicle(value: unknown, skipped: string[]): VehicleRecord | null {
  const row = asRecord(value);
  if (row === null) {
    skipped.push('a vehicle entry was not an object');
    return null;
  }
  const sync = syncFields(row);
  if (sync === null) {
    skipped.push('a vehicle had no id');
    return null;
  }
  return {
    ...sync,
    name: str(row['name']),
    make: str(row['make']),
    model: str(row['model']),
    year: num(row['year']) ?? 0,
    createdAt: num(row['createdAt']) ?? sync.updatedAt,
  };
}

function parseFillUp(value: unknown, skipped: string[]): FillUpRecord | null {
  const row = asRecord(value);
  if (row === null) {
    skipped.push('a fill-up entry was not an object');
    return null;
  }
  const sync = syncFields(row);
  if (sync === null) {
    skipped.push('a fill-up had no id');
    return null;
  }
  const vehicleId = str(row['vehicleId']);
  if (vehicleId === '') {
    skipped.push(`fill-up ${sync.id} had no vehicle`);
    return null;
  }
  // The measurements are left as they are found, including nonsense: the draft
  // gate at import time is what decides whether they are writable, and doing it
  // here as well would put the rule in two places.
  return {
    ...sync,
    vehicleId,
    date: num(row['date']) ?? 0,
    odometer: num(row['odometer']) ?? 0,
    gallons: num(row['gallons']) ?? 0,
    pricePerGallon: num(row['pricePerGallon']) ?? 0,
    isFullTank: bool(row['isFullTank'], true),
    missedPreviousFillUp: bool(row['missedPreviousFillUp'], false),
    fuelGrade: grade(row['fuelGrade']),
    station: str(row['station']),
    notes: str(row['notes']),
    latitude: num(row['latitude']),
    longitude: num(row['longitude']),
    receiptImageData: receipt(row['receiptImageData']),
  };
}

function parsePending(value: unknown, skipped: string[]): PendingFillUpRecord | null {
  const row = asRecord(value);
  if (row === null) return null;
  const sync = syncFields(row);
  if (sync === null) {
    skipped.push('a pending submission had no id');
    return null;
  }
  const vehicleId = str(row['vehicleId']);
  if (vehicleId === '') return null;
  return {
    ...sync,
    vehicleId,
    submittedAt: num(row['submittedAt']) ?? sync.updatedAt,
    submitterName: str(row['submitterName']),
    date: num(row['date']) ?? 0,
    odometer: num(row['odometer']) ?? 0,
    gallons: num(row['gallons']) ?? 0,
    pricePerGallon: num(row['pricePerGallon']) ?? 0,
    isFullTank: bool(row['isFullTank'], true),
    fuelGrade: grade(row['fuelGrade']),
    station: str(row['station']),
    notes: str(row['notes']),
    latitude: num(row['latitude']),
    longitude: num(row['longitude']),
    receiptImageData: receipt(row['receiptImageData']),
  };
}

/**
 * Reads a backup file.
 *
 * Nothing here trusts the input. It is a file a person chose: it may be
 * truncated, hand-edited, written by an older version, or not a backup at all.
 * A row that cannot be read is skipped **and reported**, so an import never
 * half-succeeds in silence.
 */
export function parseJsonBackup(text: string): ParseResult<BackupSnapshot> {
  const skipped: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { value: null, error: 'That file is not valid JSON.', skipped };
  }

  const file = asRecord(parsed);
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
  const version = num(file['formatVersion']);
  if (version !== null && version > BACKUP_FORMAT_VERSION) {
    return {
      value: null,
      error: `That backup was written by a newer version (format ${version}). Update first, then import it.`,
      skipped,
    };
  }

  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
  const vehicles = list(file['vehicles'])
    .map((row) => parseVehicle(row, skipped))
    .filter((row): row is VehicleRecord => row !== null);
  const fillUps = list(file['fillUps'])
    .map((row) => parseFillUp(row, skipped))
    .filter((row): row is FillUpRecord => row !== null);
  const pendingFillUps = list(file['pendingFillUps'])
    .map((row) => parsePending(row, skipped))
    .filter((row): row is PendingFillUpRecord => row !== null);

  return { value: { vehicles, fillUps, pendingFillUps }, error: null, skipped };
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

/** RFC 4180 quoting: wrap when needed, and double an embedded quote. */
function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.split('"').join('""')}"` : value;
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
        String(record.gallons * record.pricePerGallon),
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
    return position === undefined ? '' : (row[position] ?? '').trim();
  };

  const records: FillUpRecord[] = [];
  for (const [position, row] of rows.entries()) {
    const id = cell(row, 'id');
    const vehicleId = cell(row, 'vehicle_id');
    if (id === '' || vehicleId === '') {
      skipped.push(`row ${position + 2} has no id or vehicle`);
      continue;
    }
    const date = new Date(cell(row, 'date_iso'));
    if (Number.isNaN(date.getTime())) {
      skipped.push(`row ${position + 2} has an unreadable date`);
      continue;
    }
    records.push({
      id,
      updatedAt: date.getTime(),
      deletedAt: null,
      schemaVersion: SCHEMA_VERSION,
      vehicleId,
      date: date.getTime(),
      odometer: Number(cell(row, 'odometer_miles')),
      gallons: Number(cell(row, 'gallons')),
      pricePerGallon: Number(cell(row, 'price_per_gallon')),
      isFullTank: cell(row, 'full_tank').toLowerCase() !== 'no',
      missedPreviousFillUp: cell(row, 'missed_previous').toLowerCase() === 'yes',
      fuelGrade: grade(cell(row, 'fuel_grade')),
      station: cell(row, 'station'),
      notes: cell(row, 'notes'),
      latitude: null,
      longitude: null,
      receiptImageData: null,
    });
  }
  return { value: records, error: null, skipped };
}
