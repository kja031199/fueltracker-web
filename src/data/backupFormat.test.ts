import { describe, expect, test } from 'vitest';
import type { FillUpRecord, VehicleRecord } from './records';
import { SCHEMA_VERSION } from './records';
import {
  BACKUP_FORMAT_VERSION,
  CSV_COLUMNS,
  base64ToBytes,
  bytesToBase64,
  parseBackupFile,
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
    enteredBy: null,
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

  test('skips rows from a newer schema and says so, rather than importing them (#86)', () => {
    // A newer build's rows may carry fields this one does not know; imported,
    // the next push would send them back without those fields.
    const newer = SCHEMA_VERSION + 1;
    const file = JSON.stringify({
      format: 'fueltracker-backup',
      formatVersion: BACKUP_FORMAT_VERSION,
      schemaVersion: newer,
      vehicles: [vehicle('v1'), vehicle('v2', { schemaVersion: newer })],
      fillUps: [fillUp('f1'), fillUp('f2', { schemaVersion: newer, futureField: 'kept elsewhere' } as never)],
      pendingFillUps: [
        {
          id: 'p1',
          updatedAt: 1,
          deletedAt: null,
          schemaVersion: newer,
          vehicleId: 'v1',
          submittedAt: 1,
          submitterName: 'Sam',
          date: 1,
          odometer: 1,
          gallons: 1,
          pricePerGallon: 1,
        },
      ],
    });

    const result = parseJsonBackup(file);

    expect(result.value?.vehicles.map((row) => row.id)).toEqual(['v1']);
    expect(result.value?.fillUps.map((row) => row.id)).toEqual(['f1']);
    expect(result.value?.pendingFillUps).toEqual([]);
    expect(result.skipped).toEqual([
      expect.stringMatching(/3 rows .*newer version.*skipped/i),
    ]);
  });

  test('a newer row this build could not even read is counted as newer, not as damaged', () => {
    const file = JSON.stringify({
      format: 'fueltracker-backup',
      formatVersion: BACKUP_FORMAT_VERSION,
      fillUps: [{ ...fillUp('f9'), schemaVersion: SCHEMA_VERSION + 1, gallons: { litres: 38 } }],
    });
    const result = parseJsonBackup(file);
    expect(result.value?.fillUps).toEqual([]);
    expect(result.skipped).toEqual([expect.stringMatching(/^1 row was written by a newer version/)]);
  });

  test('a file whose rows are all this version says nothing about versions', () => {
    const result = parseJsonBackup(toJsonBackup(snapshot));
    expect(result.skipped).toEqual([]);
  });

  test('one newer row is "1 row", not "1 rows"', () => {
    const file = JSON.stringify({
      format: 'fueltracker-backup',
      formatVersion: BACKUP_FORMAT_VERSION,
      vehicles: [vehicle('v2', { schemaVersion: SCHEMA_VERSION + 1 })],
    });
    expect(parseJsonBackup(file).skipped).toEqual([expect.stringMatching(/^1 row was /)]);
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

  test('skips a row whose id could never be stored, and keeps the rest', () => {
    // #26. `a/b` is not a document name: the Firestore SDK throws on it, and
    // one such row stops every push from then on — including the tombstone
    // you would write trying to delete it. Refusing it at the door is the
    // whole fix, and refusing only *it* is the rest of the fix.
    const file = JSON.stringify({
      format: 'fueltracker-backup',
      formatVersion: 1,
      vehicles: [vehicle('v1')],
      fillUps: [fillUp('f1'), fillUp('a/b'), fillUp('__proto__'), fillUp('f2')],
      pendingFillUps: [],
    });
    const result = parseJsonBackup(file);

    expect(result.error).toBeNull();
    expect(result.value?.fillUps.map((row) => row.id)).toEqual(['f1', 'f2']);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped.join(' ')).toMatch(/id/i);
  });

  test('says which id it refused, not just that one was refused', () => {
    const file = JSON.stringify({
      format: 'fueltracker-backup',
      formatVersion: 1,
      fillUps: [fillUp('a/b')],
    });
    expect(parseJsonBackup(file).skipped.join(' ')).toContain('a/b');
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

  test('a measurement that is not a number is refused, and the reason says which', () => {
    // Changed in #54. It used to read as 0 and be left for the write gate, while
    // the same row from the account was refused here — two policies for one row.
    // Now both doors use one decoder. The *range* rule (positive, finite) still
    // belongs to the draft gate alone; this only refuses what is not a number.
    const file = JSON.stringify({
      format: 'fueltracker-backup',
      formatVersion: 1,
      fillUps: [{ ...fillUp('f1'), gallons: 'lots' }, fillUp('f2')],
    });
    const result = parseJsonBackup(file);
    expect(result.value?.fillUps.map((row) => row.id)).toEqual(['f2']);
    expect(result.skipped.join(' ')).toMatch(/f1: gallons is not a number/);
  });

  test('a negative measurement still reaches the write gate, which owns that rule', () => {
    const file = JSON.stringify({
      format: 'fueltracker-backup',
      formatVersion: 1,
      fillUps: [{ ...fillUp('f1'), gallons: -5 }],
    });
    expect(parseJsonBackup(file).value?.fillUps[0]?.gallons).toBe(-5);
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

describe('CSV is escaped for the spreadsheet as well as for the parser', () => {
  /**
   * Issue #29. RFC 4180 quoting makes a file *parse*; it does nothing about
   * what a spreadsheet *executes*. Excel, LibreOffice and Google Sheets all
   * treat a cell beginning with `=`, `+`, `-`, `@`, a tab or a carriage return
   * as a formula, and quoting does not help: `"=1+1"` is still evaluated.
   *
   * The text is not all self-authored, which is what makes this worth fixing:
   * `parseReceipt` lifts a station name out of OCR'd receipt text, an imported
   * file can carry anything, and a `pendingFillUp` (#3) carries a station and
   * notes written by somebody else entirely.
   */

  /**
   * The cell at `column` of the single data row, as a parser sees it.
   *
   * Uses `splitCsv` rather than splitting on commas, because one of the
   * fixtures below is a formula containing both a comma and quotes — the exact
   * case a naive split gets wrong.
   */
  function cellOf(record: FillUpRecord, column: string): string {
    const rows = splitCsv(toCsv([record]));
    return rows[1]![rows[0]!.indexOf(column)]!;
  }

  test.each([
    ['a formula', '=HYPERLINK("http://evil.example","click")'],
    ['a sum', '=SUM(A1:A9)'],
    ['a plus', '+1+1'],
    ['a minus', '-1+1'],
    ['an at sign', '@SUM(A1)'],
    ['a tab', '\tsneaky'],
    ['a carriage return', '\rsneaky'],
  ])('neutralises %s in a station name', (_label, station) => {
    const cell = cellOf(fillUp('f1', { station }), 'station');
    // The guard is a leading apostrophe, which spreadsheets read as "this is
    // text" and do not display.
    expect(cell.startsWith("'")).toBe(true);
  });

  test('neutralises it in the notes as well, not just the station', () => {
    const cell = cellOf(fillUp('f1', { notes: '=1+1' }), 'notes');
    expect(cell.startsWith("'")).toBe(true);
  });

  test('leaves ordinary text alone, so files do not fill with apostrophes', () => {
    expect(cellOf(fillUp('f1', { station: 'Shell' }), 'station')).toBe('Shell');
    expect(cellOf(fillUp('f1', { station: '7-Eleven' }), 'station')).toBe('7-Eleven');
  });

  test.each([
    ['a formula', '=HYPERLINK("http://evil.example","click")'],
    ['a leading tab', '\tsneaky'],
    ['a leading minus', '-5'],
    ['an apostrophe of its own', "'round the corner"],
    ['an apostrophe in front of a formula', "'=1+1"],
    ['two apostrophes in front of a formula', "''=1+1"],
  ])('round-trips %s unchanged', (_label, station) => {
    // The escape has to be reversible or an export/import cycle corrupts
    // somebody's data — which would be a worse bug than the one being fixed.
    // Note the last two cases: the guard escapes itself, so text that already
    // begins with an apostrophe survives too.
    const back = parseCsv(toCsv([fillUp('f1', { station })]));
    expect(back.error).toBeNull();
    expect(back.value?.[0]?.station).toBe(station);
  });

  test('round-trips a note that begins with a dash, which is ordinary writing', () => {
    const notes = '- topped up before the airport run';
    const back = parseCsv(toCsv([fillUp('f1', { notes })]));
    expect(back.value?.[0]?.notes).toBe(notes);
  });

  test('reads a file some other tool guarded the same way', () => {
    // Exporters that do this are common, so a leading apostrophe in front of a
    // formula character is a convention worth honouring on the way in.
    const csv =
      'id,vehicle_id,date_iso,odometer_miles,gallons,price_per_gallon,station\n' +
      "f1,v1,2025-01-15T09:30:00.000Z,10000,10,3.5,'=1+1\n";
    expect(parseCsv(csv).value?.[0]?.station).toBe('=1+1');
  });

  test('still parses numbers that were guarded', () => {
    // Nothing writes a negative measurement today — the draft gate refuses one
    // — but the guard applies to every cell, so the reader must undo it before
    // `Number()` sees the text, or a guarded number would read as NaN.
    const csv =
      'id,vehicle_id,date_iso,odometer_miles,gallons,price_per_gallon\n' +
      "f1,v1,2025-01-15T09:30:00.000Z,'-10,10,3.5\n";
    expect(parseCsv(csv).value?.[0]?.odometer).toBe(-10);
  });

  test('leaves the JSON backup alone, which nothing evaluates', () => {
    const station = '=1+1';
    const back = parseJsonBackup(
      toJsonBackup({ vehicles: [], fillUps: [fillUp('f1', { station })], pendingFillUps: [] }),
    );
    expect(back.value?.fillUps[0]?.station).toBe(station);
    expect(toJsonBackup({ vehicles: [], fillUps: [fillUp('f1', { station })], pendingFillUps: [] }))
      .not.toContain("'=1+1");
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

  test('skips a CSV row whose id could never be stored', () => {
    // The same door, the other file format. A spreadsheet is a very easy place
    // for an id to pick up a slash.
    const csv =
      'id,vehicle_id,date_iso,odometer_miles,gallons,price_per_gallon\n' +
      'f1,v1,2025-01-15T09:30:00.000Z,10000,10,3.5\n' +
      'a/b,v1,2025-01-16T09:30:00.000Z,10300,9,3.5\n';
    const result = parseCsv(csv);
    expect(result.value?.map((row) => row.id)).toEqual(['f1']);
    expect(result.skipped.join(' ')).toMatch(/id/i);
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

describe('a chosen file, read by its name (#93)', () => {
  // Moved out of the Settings screen, where it carried an `as never[]` cast.
  test('a .csv is fill-ups alone, in a snapshot with no vehicles or submissions', () => {
    const read = parseBackupFile('fuel.csv', toCsv([fillUp('f1')]));
    expect(read.error).toBeNull();
    expect(read.value?.vehicles).toEqual([]);
    expect(read.value?.pendingFillUps).toEqual([]);
    expect(read.value?.fillUps.map((row) => row.id)).toEqual(['f1']);
  });

  test('the extension is read whatever its case', () => {
    expect(parseBackupFile('FUEL.CSV', toCsv([fillUp('f1')])).value?.fillUps).toHaveLength(1);
  });

  test('anything else is a JSON backup, whole', () => {
    const read = parseBackupFile('backup.json', toJsonBackup(snapshot));
    expect(read.value?.vehicles.map((row) => row.id)).toEqual(['v1']);
    expect(read.value?.fillUps).toHaveLength(2);
  });

  test('only the last extension counts, and no extension means JSON', () => {
    expect(parseBackupFile('fuel.csv.json', toJsonBackup(snapshot)).value?.vehicles).toHaveLength(1);
    expect(parseBackupFile('', toJsonBackup(snapshot)).value?.vehicles).toHaveLength(1);
    // A backup renamed to .csv is read as CSV, and says it cannot be.
    expect(parseBackupFile('backup.csv', toJsonBackup(snapshot)).value).toBeNull();
  });

  test('a file that cannot be read says why, and holds nothing', () => {
    expect(parseBackupFile('backup.json', '{ not json')).toEqual({
      value: null,
      error: 'That file is not valid JSON.',
      skipped: [],
    });
    expect(parseBackupFile('fuel.csv', '')).toMatchObject({ value: null, error: 'That file is empty.' });
  });

  test('rows a CSV skips are still reported', () => {
    const csv = toCsv([fillUp('f1')]) + '\n' + 'garbage,'.repeat(CSV_COLUMNS.length);
    const read = parseBackupFile('fuel.csv', csv);
    expect(read.value?.fillUps).toHaveLength(1);
    expect(read.skipped.length).toBeGreaterThan(0);
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
