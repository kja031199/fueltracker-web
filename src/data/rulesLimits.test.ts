import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { TEXT_LIMITS } from '../domain/textLimits';
import { MAX_ID_LENGTH } from './recordId';
import { MAX_EMAIL_LENGTH } from './sharing';
import { SCHEMA_VERSION, type FillUpRecord, type PendingFillUpRecord, type VehicleRecord } from './records';
import type { Invite, Member, Membership } from './sharing';

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

/**
 * The rules' function definitions, by name, with their bodies — read the way
 * the rest of this file reads the rules: as text, so it needs no emulator.
 */
function functionBody(name: string): string | undefined {
  const start = RULES.search(new RegExp(`function ${name}\\(`));
  if (start === -1) return undefined;
  let depth = 0;
  for (let i = RULES.indexOf('{', start); i < RULES.length; i += 1) {
    if (RULES[i] === '{') depth += 1;
    if (RULES[i] === '}') depth -= 1;
    if (depth === 0) return RULES.slice(start, i + 1);
  }
  return undefined;
}

/** Comments out, so prose that mentions `.size()` or `hasOnly` is not code. */
const CODE = RULES.split('\n')
  .map((line) => line.replace(/\/\/.*$/, ''))
  .join('\n');

describe('every size bound is one the tests can read (#92)', () => {
  // Bounds written inline — `x.size() <= 200` — were invisible to the parity
  // checks above: the invitation's fields, a row's id, the receipt.
  const HELPERS = ['label', 'sized', 'receipt'];

  test('no `.size()` outside the functions that name a bound', () => {
    let rest = CODE;
    for (const name of HELPERS) {
      const body = functionBody(name);
      expect(body, name).toBeDefined();
      rest = rest.replace(body!, '');
    }
    expect(rest).not.toMatch(/\.size\(\)/);
  });

  const SIZED = [...CODE.matchAll(/sized\(request\.resource\.data\.(\w+),\s*(\d+),\s*(\d+)\)/g)].map((match) => ({
    field: match[1]!,
    min: Number(match[2]),
    max: Number(match[3]),
  }));
  const EXPECTED: Record<string, readonly [number, number]> = {
    // An id is a document name: never empty, never longer than the client allows.
    id: [1, MAX_ID_LENGTH],
    vehicleId: [1, MAX_ID_LENGTH],
    // `normalizeEmail` takes three characters at least (a@b) and at most 320.
    email: [3, MAX_EMAIL_LENGTH],
  };

  test('there are sized fields to check: the id, the car id and the address', () => {
    expect(new Set(SIZED.map((entry) => entry.field))).toEqual(new Set(Object.keys(EXPECTED)));
  });

  test.each(SIZED)('rules size $field from $min to $max, as the client does', ({ field, min, max }) => {
    expect([min, max]).toEqual(EXPECTED[field]);
  });
});

/**
 * A key list from the rules, resolved: `[...]`, `name()`, and `.concat(...)`
 * of those — all the rules here use to build one.
 */
function keysOf(name: string): string[] {
  const body = functionBody(name);
  if (body === undefined) throw new Error(`firestore.rules has no ${name}()`);
  const expression = /return\s+([\s\S]*?);\s*\}\s*$/.exec(body.replace(/\/\/.*$/gm, ''))?.[1];
  if (expression === undefined) throw new Error(`${name}() does not return a list`);
  return expression
    .split(/\.concat\(/)
    // Every part after the first closes its `.concat(`.
    .map((part, index) => (index === 0 ? part : part.replace(/\)\s*$/, '')).trim())
    .flatMap((part) => {
      const call = /^(\w+)\(\)$/.exec(part);
      if (call !== null) return keysOf(call[1]!);
      return [...part.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
    });
}

describe('each document’s keys are listed once, and are what the client writes (#92)', () => {
  test('`hasOnly` and `hasAll` appear once each, in the one helper that uses a key list', () => {
    expect(CODE.match(/hasOnly\(/g)).toHaveLength(1);
    expect(CODE.match(/hasAll\(/g)).toHaveLength(1);
  });

  const SYNC = { id: 'x', updatedAt: 1, deletedAt: null, schemaVersion: SCHEMA_VERSION };
  const vehicle: Required<VehicleRecord> = { ...SYNC, name: '', make: '', model: '', year: 2020, createdAt: 1 };
  const fillUp: Required<FillUpRecord> = {
    ...SYNC, vehicleId: 'v', date: 1, odometer: 1, gallons: 1, pricePerGallon: 1, isFullTank: true,
    missedPreviousFillUp: false, fuelGrade: 'Regular', station: '', notes: '', latitude: null, longitude: null,
    receiptImageData: null, enteredBy: null,
  };
  const pending: Required<PendingFillUpRecord> = {
    ...SYNC, vehicleId: 'v', submittedAt: 1, submitterName: '', date: 1, odometer: 1, gallons: 1,
    pricePerGallon: 1, isFullTank: true, fuelGrade: 'Regular', station: '', notes: '', latitude: null,
    longitude: null, receiptImageData: null,
  };
  const invite: Required<Invite> = { ownerUid: '', vehicleId: '', email: '', ownerName: '', vehicleName: '', createdAt: 1 };
  const member: Required<Member> = { uid: '', name: '', email: '', joinedAt: 1 };
  const membership: Required<Membership> = { ownerUid: '', vehicleId: '', ownerName: '', vehicleName: '' };

  // Every synced row also carries the server's stamp, which the client adds
  // as it writes (`syncedAt`, #52).
  test.each([
    ['vehicleKeys', [...Object.keys(vehicle), 'syncedAt']],
    ['fillUpKeys', [...Object.keys(fillUp), 'syncedAt']],
    ['pendingKeys', [...Object.keys(pending), 'syncedAt']],
    ['inviteKeys', Object.keys(invite)],
    ['memberKeys', Object.keys(member)],
    ['membershipKeys', Object.keys(membership)],
  ])('%s() is every field the client writes', (name, written) => {
    const listed = keysOf(name);
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual([...written].sort());
  });

  test('the only optional field is a fill-up’s `enteredBy`, which older builds do not write (#66)', () => {
    expect(keysOf('optionalFillUpKeys')).toEqual(['enteredBy']);
    expect(keysOf('fillUpKeys')).toContain('enteredBy');
  });
});

describe('no document is read twice to answer one question (#92)', () => {
  test('nothing is checked with `exists()` and then read with `get()`', () => {
    // The argument of each `call(...)`, brackets balanced: a path has `$(...)` inside it.
    const paths = (call: string): string[] =>
      [...CODE.matchAll(new RegExp(`\\b${call}\\(`, 'g'))].map((match) => {
        let depth = 1;
        let i = match.index! + match[0].length;
        const start = i;
        for (; depth > 0; i += 1) {
          if (CODE[i] === '(') depth += 1;
          if (CODE[i] === ')') depth -= 1;
        }
        return CODE.slice(start, i - 1).replace(/\s+/g, '');
      });
    const read = new Set(paths('get'));
    expect(read.size).toBeGreaterThan(0);
    for (const path of paths('exists')) expect(read.has(path), path).toBe(false);
  });
});
