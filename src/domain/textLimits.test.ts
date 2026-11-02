import { describe, expect, test } from 'vitest';
import { FUEL_GRADES } from './fuelGrade';
import { TEXT_LIMITS, boundText } from './textLimits';

/**
 * Issue #50. The account refuses a document whose text is longer than
 * `firestore.rules` allows, and before this nothing on the client bounded text
 * at all — so one long station name failed the whole upload batch and, because
 * a refusal looked like being off the allowlist, locked an allowed account out.
 *
 * `boundText` is the one place text is shortened. It measures in UTF-16 code
 * units, exactly like JavaScript's `.length`, because that is what the rules'
 * `string.size()` counts: measured against the emulator, 200 `é` (400 UTF-8
 * bytes) are accepted and 150 emoji (150 code points, 300 UTF-16 units) are
 * refused.
 */
describe('boundText', () => {
  test('leaves text within the limit untouched — the same string, not a copy', () => {
    const value = 'Shell on Main St';
    expect(boundText(value, 200)).toBe(value);
  });

  test('keeps text exactly at the limit', () => {
    expect(boundText('x'.repeat(200), 200)).toHaveLength(200);
  });

  test('shortens text one past the limit to the limit', () => {
    expect(boundText('x'.repeat(201), 200)).toBe('x'.repeat(200));
  });

  test('counts UTF-16 units, as the rules do', () => {
    // 100 emoji are 200 units: at the limit, kept whole.
    expect(boundText('😀'.repeat(100), 200)).toBe('😀'.repeat(100));
    // 150 emoji are 300 units: the rules refuse this, so it must shrink.
    expect(boundText('😀'.repeat(150), 200)).toHaveLength(200);
  });

  test('never cuts an emoji in half', () => {
    // 'a' then emoji: the 200-unit cut lands between the halves of a pair.
    // A lone surrogate is not valid text, so the half is dropped instead.
    const bounded = boundText(`a${'😀'.repeat(150)}`, 200);
    expect(bounded).toHaveLength(199);
    expect(bounded.endsWith('😀')).toBe(true);
    expect(/[\uD800-\uDBFF]$/.test(bounded)).toBe(false);
  });

  test('a non-positive limit yields empty text rather than throwing', () => {
    expect(boundText('anything', 0)).toBe('');
    expect(boundText('anything', -5)).toBe('');
  });
});

describe('TEXT_LIMITS', () => {
  test('every fuel grade fits its own limit', () => {
    for (const grade of FUEL_GRADES) {
      expect(grade.length).toBeLessThanOrEqual(TEXT_LIMITS.fuelGrade);
    }
  });
});
