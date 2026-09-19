import { describe, expect, test } from 'vitest';
import type { FillUpRecord, VehicleRecord } from '../data/records';
import { SCHEMA_VERSION } from '../data/records';
import {
  BACKUP_FORMAT_VERSION,
  CSV_COLUMNS,
  base64ToBytes,
  bytesToBase64,
  parseCsv,
  parseJsonBackup,
  splitCsv,
  toCsv,
  toJsonBackup,
} from './backupFormat';

function vehicle(id: string, overrides: Partial<VehicleRecord> = {}): VehicleRecord {
  return {
    id,
    updatedAt: 1_000,
    deletedAt: null,
    schemaVersion: SCHEMA_VERSION,
    name: 'Daily Driver',
    make: 'Honda',
    model: 'Civic',
    year: 2021,
    createdAt: 1_000,
    ...overrides,
  };
}

function fillUp(id: string, overrides: Partial<FillUpRecord> = {}): FillUpRecord {
  return {
    id,
    updatedAt: 2_000,
    deletedAt: null,
    schemaVersion: SCHEMA_VERSION,
    vehicleId: 'v1',
    date: Date.UTC(2025, 0, 15, 9, 30),
    odometer: 10_000,
    gallons: 10,
    pricePerGallon: 3.499,
    isFullTank: true,
    missedPreviousFillUp: false,
    fuelGrade: 'Regular',
    station: 'Shell',
    notes: '',
    latitude: null,
    longitude: null,
    receiptImageData: null,
    ...overrides,
  };
}

const snapshot = {
  vehicles: [vehicle('v1')],
  fillUps: [fillUp('f1'), fillUp('f2', { odometer: 10_400 })],
  pendingFillUps: [],
};

describe('base64', () => {
  test('round-trips bytes exactly', () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255, 42]);
    expect(Array.from(base64ToBytes(bytesToBase64(bytes))!)).toEqual([0, 1, 127, 128, 255, 42]);
  });

  test('handles a blob far past the argument limit', () => {
    // String.fromCharCode(...bytes) blows the call stack somewhere around a
    // hundred thousand arguments, and a receipt can be four megabytes.
    const big = new Uint8Array(300_000).map((_, i) => i % 256);
    const round = base64ToBytes(bytesToBase64(big));
    expect(round).not.toBeNull();
    expect(round!.length).toBe(300_000);
    expect(round![299_999]).toBe(big[299_999]);
  });

  test('returns null for text that is not base64', () => {
    expect(base64ToBytes('not base64!!')).toBeNull();
  });
});

describe('the JSON backup', () => {
  test('round-trips a snapshot unchanged', () => {
    const result = parseJsonBackup(toJsonBackup(snapshot));
    expect(result.error).toBeNull();
    expect(result.skipped).toEqual([]);
    expect(result.value?.vehicles).toEqual(snapshot.vehicles);
    expect(result.value?.fillUps).toEqual(snapshot.fillUps);
  });

  test('carries receipt bytes through intact', () => {
    // A backup that silently drops photos is a backup that lies.
    const bytes = new Uint8Array([1, 2, 3, 250]);
    const withReceipt = { ...snapshot, fillUps: [fillUp('f1', { receiptImageData: bytes })] };
    const back = parseJsonBackup(toJsonBackup(withReceipt)).value;
    expect(Array.from(back!.fillUps[0]!.receiptImageData!)).toEqual([1, 2, 3, 250]);
  });

  test('carries tombstones, so a deletion survives the round trip', () => {
    const deleted = { ...snapshot, fillUps: [fillUp('f1', { deletedAt: 5_000 })] };
    expect(parseJsonBackup(toJsonBackup(deleted)).value?.fillUps[0]?.deletedAt).toBe(5_000);
  });

  test('stamps what wrote it', () => {
    const file: unknown = JSON.parse(toJsonBackup(snapshot, new Date(Date.UTC(2025, 5, 1))));
    const parsed = file as Record<string, unknown>;
    expect(parsed['format']).toBe('fueltracker-backup');
    expect(parsed['formatVersion']).toBe(BACKUP_FORMAT_VERSION);
    expect(parsed['exportedAt']).toBe('2025-06-01T00:00:00.000Z');
  });
});

describe('reading a hostile backup file', () => {
  test('rejects text that is not JSON', () => {
    const result = parseJsonBackup('{ truncated');
    expect(result.value).toBeNull();
    expect(result.error).toMatch(/not valid JSON/i);
  });

  test('rejects valid JSON that is not a backup', () => {
    expect(parseJsonBackup('{"hello":"world"}').error).toMatch(/not a FuelTracker backup/i);
    expect(parseJsonBackup('[1,2,3]').error).toMatch(/not a FuelTracker backup/i);
    expect(parseJsonBackup('null').error).toMatch(/not a FuelTracker backup/i);
  });

  test('refuses a file from a newer version rather than guessing', () => {
    const future = JSON.stringify({ format: 'fueltracker-backup', formatVersion: 99 });
    expect(parseJsonBackup(future).error).toMatch(/newer version/i);
  });

  test('skips rows it cannot read and says which, rather than failing wholesale', () => {
    // One bad row should not cost someone the other nine hundred.
    const file = JSON.stringify({
      format: 'fueltracker-backup',
      formatVersion: 1,
      vehicles: [vehicle('v1'), { name: 'no id here' }, 'not an object'],
      fillUps: [fillUp('f1'), { id: 'f2' }],
      pendingFillUps: [],
    });
    const result = parseJsonBackup(file);
    expect(result.error).toBeNull();
    expect(result.value?.vehicles).toHaveLength(1);
    expect(result.value?.fillUps).toHaveLength(1);
    expect(result.skipped.length).toBe(3);
    expect(result.skipped.join(' ')).toMatch(/no id/);
  });

  test('missing collections read as empty rather than throwing', () => {
    const result = parseJsonBackup(
      JSON.stringify({ format: 'fueltracker-backup', formatVersion: 1 }),
    );
    expect(result.error).toBeNull();
    expect(result.value?.vehicles).toEqual([]);
    expect(result.value?.fillUps).toEqual([]);
  });

  test('an unknown fuel grade degrades to Other rather than being rejected', () => {
    const file = JSON.stringify({
      format: 'fueltracker-backup',
      formatVersion: 1,
      fillUps: [{ ...fillUp('f1'), fuelGrade: 'Nitro' }],
    });
    expect(parseJsonBackup(file).value?.fillUps[0]?.fuelGrade).toBe('Other');
  });

  test('nonsense measurements survive parsing and are left for the write gate', () => {
    // Deliberate: the draft decides what is writable, and putting that rule
    // here too would mean maintaining it in two places.
    const file = JSON.stringify({
      format: 'fueltracker-backup',
      formatVersion: 1,
      fillUps: [{ ...fillUp('f1'), gallons: 'lots' }],
    });
    expect(parseJsonBackup(file).value?.fillUps[0]?.gallons).toBe(0);
  });
});

describe('CSV writing', () => {
  test('writes a header and one row per fill-up', () => {
    const lines = toCsv(snapshot.fillUps).trim().split('\n');
    expect(lines[0]).toBe(CSV_COLUMNS.join(','));
    expect(lines).toHaveLength(3);
  });

  test('quotes fields containing commas, quotes or newlines', () => {
    // A station name with a comma and a note with a newline are both ordinary,
    // and a naive join corrupts the row silently.
    const csv = toCsv([
      fillUp('f1', { station: 'Shell, Main St', notes: 'said "fill it"\nthen left' }),
    ]);
    expect(csv).toContain('"Shell, Main St"');
    expect(csv).toContain('"said ""fill it""\nthen left"');
  });

  test('names the unit in every measurement column', () => {
    // The file's meaning must not depend on a setting that is not in the file.
    expect(CSV_COLUMNS).toContain('odometer_miles');
    expect(CSV_COLUMNS).toContain('price_per_gallon');
  });

  test('an empty list still produces a usable header', () => {
    expect(toCsv([]).trim()).toBe(CSV_COLUMNS.join(','));
  });
});

describe('CSV reading', () => {
  test('round-trips the fields it carries', () => {
    const result = parseCsv(toCsv(snapshot.fillUps));
    expect(result.error).toBeNull();
    expect(result.value).toHaveLength(2);
    expect(result.value?.[0]?.odometer).toBe(10_000);
    expect(result.value?.[0]?.pricePerGallon).toBeCloseTo(3.499, 6);
    expect(result.value?.[0]?.station).toBe('Shell');
  });

  test('round-trips quoted commas, quotes and newlines', () => {
    const tricky = fillUp('f1', { station: 'Shell, Main St', notes: 'a "quote"\nand a line' });
    const back = parseCsv(toCsv([tricky])).value;
    expect(back?.[0]?.station).toBe('Shell, Main St');
    expect(back?.[0]?.notes).toBe('a "quote"\nand a line');
  });

  test('reads CRLF line endings, which is what a spreadsheet writes', () => {
    const csv = toCsv(snapshot.fillUps).split('\n').join('\r\n');
    expect(parseCsv(csv).value).toHaveLength(2);
  });

  test('matches columns by name, so reordering and extra columns are fine', () => {
    const csv =
      'notes,gallons,vehicle_id,id,price_per_gallon,odometer_miles,date_iso,spreadsheet_junk\n' +
      'hello,10,v1,f1,3.5,10000,2025-01-15T09:30:00.000Z,ignored\n';
    const record = parseCsv(csv).value?.[0];
    expect(record?.id).toBe('f1');
    expect(record?.gallons).toBe(10);
    expect(record?.notes).toBe('hello');
  });

  test('a missing required column is an error, not a silent zero', () => {
    const csv = 'id,vehicle_id,date_iso,odometer_miles\nf1,v1,2025-01-15T00:00:00Z,10000\n';
    const result = parseCsv(csv);
    expect(result.value).toBeNull();
    expect(result.error).toMatch(/missing required columns: gallons, price_per_gallon/);
  });

  test('an empty file says so', () => {
    expect(parseCsv('').error).toMatch(/empty/i);
  });

  test('a header-only file reads as no records', () => {
    const result = parseCsv(`${CSV_COLUMNS.join(',')}\n`);
    expect(result.error).toBeNull();
    expect(result.value).toEqual([]);
  });

  test('skips unreadable rows and names them by line number', () => {
    const csv =
      `${CSV_COLUMNS.join(',')}\n` +
      'f1,v1,2025-01-15T00:00:00Z,10000,10,3.5,35,yes,no,Regular,Shell,\n' +
      'f2,v1,not-a-date,10400,10,3.5,35,yes,no,Regular,Shell,\n' +
      ',,2025-01-20T00:00:00Z,10800,10,3.5,35,yes,no,Regular,Shell,\n';
    const result = parseCsv(csv);
    expect(result.value).toHaveLength(1);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped[0]).toMatch(/row 3/);
    expect(result.skipped[1]).toMatch(/row 4/);
  });

  test('a large file parses without trouble', () => {
    const rows = Array.from({ length: 5_000 }, (_, i) =>
      fillUp(`f${i}`, { odometer: 10_000 + i * 300 }),
    );
    const result = parseCsv(toCsv(rows));
    expect(result.value).toHaveLength(5_000);
  });
});

describe('splitCsv', () => {
  test('keeps empty trailing cells', () => {
    expect(splitCsv('a,b,\n')).toEqual([['a', 'b', '']]);
  });

  test('treats a quoted empty field as empty, not missing', () => {
    expect(splitCsv('a,"",c')).toEqual([['a', '', 'c']]);
  });

  test('does not emit a blank row for a trailing newline', () => {
    expect(splitCsv('a,b\nc,d\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });
});
