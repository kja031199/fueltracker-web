import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { TEXT_LIMITS } from '../domain/textLimits';
import { MAX_ID_LENGTH } from './recordId';

/**
 * The client's text limits and the rules' must be the same numbers (#50).
 *
 * They drifted once already, in the worst direction: the rules bounded text and
 * the client did not, so the account refused what the app had happily saved.
 * This reads the limits out of `firestore.rules` itself — the way
 * `rules.test.ts` reads the allowlist — so changing one side alone fails here,
 * without needing the emulator.
 */
const RULES = readFileSync('firestore.rules', 'utf8');
const LABELS = [...RULES.matchAll(/label\(request\.resource\.data\.(\w+),\s*(\d+)\)/g)].map(
  (match) => ({ field: match[1]!, max: Number(match[2]) }),
);

describe('the rules and the client agree on text limits', () => {
  test('there are limits to compare, so a passing suite means something', () => {
    // Nine today: three vehicle fields, three shared by fill-ups and
    // submissions, the submitter's name, and vehicleId twice.
    expect(LABELS.length).toBeGreaterThanOrEqual(9);
  });

  test.each(LABELS)('rules bound $field at $max, and so does the client', ({ field, max }) => {
    if (field === 'vehicleId') {
      // A vehicle id is an id: the id rule bounds it, not the text table.
      expect(max).toBe(MAX_ID_LENGTH);
      return;
    }
    expect(TEXT_LIMITS).toHaveProperty(field);
    expect(TEXT_LIMITS[field as keyof typeof TEXT_LIMITS]).toBe(max);
  });

  test.each(Object.keys(TEXT_LIMITS))('the client limit for %s is one the rules enforce', (field) => {
    // The other direction: a client limit the rules have never heard of is a
    // number nobody is checking against.
    expect(LABELS.map((label) => label.field)).toContain(field);
  });
});
