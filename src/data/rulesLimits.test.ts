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

describe('the rules and the client agree on how far ahead a stamp may be (#79)', () => {
  // The client adopts another device's stamp up to MAX_ADOPTED_SKEW_MS ahead
  // of its own clock, so the rules must accept at least that, plus slack for a
  // device whose own clock is a little fast — and not much more, or a stamp
  // far enough ahead to lock a fill-up gets through.
  const bound = /function maxAheadMs\(\)\s*\{\s*return\s+(\d+);\s*\}/.exec(RULES)?.[1];

  test('the rules name the bound in one function, as a plain number', () => {
    expect(bound).toBeDefined();
  });

  test('it is the client constant', async () => {
    const { MAX_ACCEPTED_AHEAD_MS } = await import('./syncClock');
    expect(Number(bound)).toBe(MAX_ACCEPTED_AHEAD_MS);
  });

  test('it is above what an honest device adopts, so none is ever refused for it', async () => {
    const { MAX_ACCEPTED_AHEAD_MS, MAX_ADOPTED_SKEW_MS } = await import('./syncClock');
    expect(MAX_ACCEPTED_AHEAD_MS).toBeGreaterThan(MAX_ADOPTED_SKEW_MS);
    expect(MAX_ACCEPTED_AHEAD_MS - MAX_ADOPTED_SKEW_MS).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000);
  });

  test('the stamp is checked in the one place every row passes through', () => {
    expect(RULES).toMatch(/updatedAt\s*<=\s*request\.time\.toMillis\(\)\s*\+\s*maxAheadMs\(\)/);
    expect(RULES).toMatch(/resource\s*==\s*null\s*\|\|\s*request\.resource\.data\.updatedAt\s*>=\s*resource\.data\.updatedAt/);
  });
});
