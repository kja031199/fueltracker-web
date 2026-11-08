import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { isFiniteNumber, isRecord, numberOr, textOr } from './guards';

/**
 * The small checks every decoder makes, written once (#91).
 *
 * They had been written out in five modules, and under one name two different
 * things: `finite` was a yes/no check in three places and "the number, or 0"
 * in a fourth.
 */

describe('isRecord', () => {
  test.each([
    [{}, true],
    [{ a: 1 }, true],
    [Object.create(null), true],
    [null, false],
    [undefined, false],
    [[], false],
    [[1, 2], false],
    ['text', false],
    [42, false],
    [() => 1, false],
  ])('%o → %s', (value, expected) => {
    expect(isRecord(value)).toBe(expected);
  });
});

describe('isFiniteNumber', () => {
  test.each([
    [0, true],
    [-1.5, true],
    [Number.MAX_SAFE_INTEGER, true],
    [Number.NaN, false],
    [Number.POSITIVE_INFINITY, false],
    [Number.NEGATIVE_INFINITY, false],
    ['1', false],
    [null, false],
    [undefined, false],
    [{}, false],
  ])('%o → %s', (value, expected) => {
    expect(isFiniteNumber(value)).toBe(expected);
  });
});

describe('textOr', () => {
  test('text stays text, and is cut when a limit is given', () => {
    expect(textOr('Shell')).toBe('Shell');
    expect(textOr('x'.repeat(10), 4)).toBe('xxxx');
  });

  test('anything that is not text is empty, never "[object Object]"', () => {
    for (const value of [null, undefined, 42, {}, [], true, Number.NaN]) expect(textOr(value)).toBe('');
  });
});

describe('numberOr', () => {
  test('a finite number is itself; anything else is the fallback', () => {
    expect(numberOr(12, 0)).toBe(12);
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, '12', null, undefined, {}]) {
      expect(numberOr(value, 7)).toBe(7);
    }
  });
});

describe('nothing in src/data defines its own copy (#91)', () => {
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sources(path);
      return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
    });
  }

  test('no `finite`, `text`, `isRaw` or `asRecord` helper outside guards.ts, and one batch limit', () => {
    const copies: string[] = [];
    let batchLimits = 0;
    for (const file of sources('src/data')) {
      const code = readFileSync(file, 'utf8');
      if (/BATCH_LIMIT\s*=/.test(code)) batchLimits += 1;
      if (file.endsWith('guards.ts')) continue;
      for (const match of code.matchAll(/\bfunction (finite|text|isRaw|asRecord)\s*\(/g)) copies.push(`${file}: ${match[1]}`);
    }
    expect(copies).toEqual([]);
    expect(batchLimits).toBe(1);
  });
});
