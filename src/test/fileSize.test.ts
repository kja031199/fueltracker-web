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
  // None. `App.tsx` was here at 355 lines until #93's route table split it.
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

  // `test.each` over an empty table runs nothing, so it is skipped then, and
  // this file still checks every interface file against the limit above.
  test.skipIf(Object.keys(ALLOWED).length === 0).each(Object.entries(ALLOWED))('%s is allowed over, but no further, and only while it needs to be', (file, allowance) => {
    expect(allowance.reason.length).toBeGreaterThan(10);
    expect(lineCount(file)).toBeLessThanOrEqual(allowance.lines);
    expect(lineCount(file)).toBeGreaterThan(LIMIT);
  });
});
