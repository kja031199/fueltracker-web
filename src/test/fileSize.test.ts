import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { sourcesUnder } from './imports';

/**
 * No interface file over 300 lines (#93).
 *
 * The fill-up form, the fuel log and Settings had grown to 314–474 lines each,
 * doing several jobs apiece — the form alone held its state, the receipt scan,
 * the save, and three copies of the same number field. Past a few hundred
 * lines a component is usually more than one thing. This holds the line; an
 * exception is named with the change that will remove it.
 */

export const LIMIT = 300;

/** Files allowed over the limit, each with the most it may be and why. */
export const ALLOWED: Readonly<Record<string, { readonly lines: number; readonly reason: string }>> = {
  'src/ui/App.tsx': { lines: 355, reason: 'its if-chain of screens becomes a route table in #93 part 5' },
};

const lineCount = (file: string): number => readFileSync(file, 'utf8').split('\n').length - 1;

const FILES = sourcesUnder('src/ui', false);

describe('interface files stay small', () => {
  test('there are files to check', () => {
    expect(FILES.length).toBeGreaterThan(40);
  });

  test.each(FILES.filter((file) => !(file in ALLOWED)))(`%s is at most ${LIMIT} lines`, (file) => {
    expect(lineCount(file)).toBeLessThanOrEqual(LIMIT);
  });

  test.each(Object.entries(ALLOWED))('%s is allowed over, but no further, and only while it needs to be', (file, allowance) => {
    expect(allowance.reason.length).toBeGreaterThan(10);
    expect(lineCount(file)).toBeLessThanOrEqual(allowance.lines);
    expect(lineCount(file)).toBeGreaterThan(LIMIT);
  });
});
