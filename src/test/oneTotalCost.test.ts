import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { sourcesUnder } from './imports';

/**
 * Total cost is worked out in one place (#93): `totalCost` in
 * `domain/models.ts`.
 *
 * It existed in five forms, and inline in three more files, so a change to
 * how cost is figured — rounding, a fee, a unit — would have had to find all
 * of them. This refuses another `gallons * price` anywhere else.
 */

const HOME = 'src/domain/models.ts';
const MULTIPLIED = /\bgallons\s*\*\s*[\w.]*price/i;

/** Lines of `source` that multiply gallons by a price. Comments are prose, not arithmetic. */
export function costLines(source: string): string[] {
  return source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .filter((line) => MULTIPLIED.test(line));
}

const CHECKED = sourcesUnder('src', false).filter((file) => file !== HOME);

describe('one total-cost formula', () => {
  test('the check finds the forms it is for, so a clean result means something', () => {
    expect(costLines('const t = record.gallons * record.pricePerGallon;')).toHaveLength(1);
    expect(costLines('const t = gallons * price;')).toHaveLength(1);
    expect(costLines('(reading.gallons * reading.pricePerGallon * 100)')).toHaveLength(1);
    expect(costLines('const g = Math.round(gallons * 1000) / 1000;')).toEqual([]);
    expect(costLines(' * gallons * price, in a doc comment')).toEqual([]);
  });

  test('it reads every layer, including the files that had their own copy', () => {
    const files = sourcesUnder('src', false);
    for (const had of [
      'src/data/backupFormat.ts',
      'src/domain/scanning/pumpScanParser.ts',
      'src/domain/scanning/corroboration.ts',
      'src/ui/FillUpsScreen.tsx',
      'src/ui/PendingReview.tsx',
    ]) {
      expect(CHECKED, had).toContain(had);
    }
    expect(CHECKED.length).toBe(files.length - 1);
  });

  test('its home has it', () => {
    expect(costLines(readFileSync(HOME, 'utf8'))).toHaveLength(1);
  });

  test.each(CHECKED)('%s', (file) => {
    expect(costLines(readFileSync(file, 'utf8'))).toEqual([]);
  });
});
