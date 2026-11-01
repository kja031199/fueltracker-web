import { describe, expect, test } from 'vitest';
import { MAX_ID_LENGTH, idProblem, isStorableId } from './recordId';

/**
 * Which record ids can actually be stored.
 *
 * Issue #26: an id was checked for type and length and nothing else, while
 * `remoteStore.push` addresses a document *by* that id. Firestore's legal
 * document ids are a narrower set than "a string", and the failures are
 * uneven — probed against the installed SDK:
 *
 *     "ok-uuid-1234" -> users/u1/fillUps/ok-uuid-1234
 *     "a/b"          -> THROWS: Invalid document reference … has 5 segments
 *     "a/b/c"        -> users/u1/fillUps/a/b/c   (a path the rules never match)
 *     "__proto__"    -> builds, then the server refuses __.*__
 *     "."  / ".."    -> build, then the server refuses both
 *
 * Each of those stops a whole `writeBatch`, on every sync, forever — so this
 * is a rule about availability, not tidiness.
 */

describe('ids that are fine', () => {
  test.each([
    ['a uuid', '8f14e45f-ceea-467a-9f3a-1c0a4f1a9b77'],
    ['the test suite\'s own ids', 'id-1'],
    ['dots inside a name', 'fill.up.1'],
    ['underscores that are not a reserved pair', '__leading'],
    ['a trailing pair only', 'trailing__'],
    ['unicode', 'remplissage-café'],
    ['a single character', 'a'],
    ['exactly the maximum length', 'x'.repeat(MAX_ID_LENGTH)],
  ])('accepts %s', (_label, id) => {
    expect(idProblem(id)).toBeNull();
    expect(isStorableId(id)).toBe(true);
  });
});

describe('ids that break a document path', () => {
  test.each([
    ['a slash', 'a/b'],
    ['two slashes', 'a/b/c'],
    ['a leading slash', '/abs'],
    ['a trailing slash', 'rel/'],
    ['a path traversal', '../../other'],
  ])('refuses %s', (_label, id) => {
    expect(idProblem(id)).not.toBeNull();
    expect(isStorableId(id)).toBe(false);
  });

  test('says what the problem is, so the reason can be shown', () => {
    expect(idProblem('a/b')).toMatch(/\//);
  });
});

describe('ids Firestore reserves', () => {
  test.each([
    ['a single dot', '.'],
    ['a double dot', '..'],
    ['the reserved pattern', '__proto__'],
    ['another reserved name', '__name__'],
    ['the shortest reserved name', '____'],
  ])('refuses %s', (_label, id) => {
    expect(isStorableId(id)).toBe(false);
  });

  test('does not refuse a name that merely contains dots or underscores', () => {
    // The rule is `__.*__` and the exact names `.` and `..`, not "anything
    // with an underscore in it" — over-refusing would reject ids this app has
    // already written.
    expect(isStorableId('..a')).toBe(true);
    expect(isStorableId('a..')).toBe(true);
    expect(isStorableId('_x_')).toBe(true);
  });
});

describe('ids that are not strings, or not plausible', () => {
  test.each([
    ['undefined', undefined],
    ['null', null],
    ['a number', 7],
    ['an object', { id: 'a' }],
    ['an array', ['a']],
    ['empty', ''],
  ])('refuses %s', (_label, value) => {
    expect(isStorableId(value)).toBe(false);
  });

  test('refuses one longer than any uuid', () => {
    expect(idProblem('x'.repeat(MAX_ID_LENGTH + 1))).toMatch(/long/i);
  });

  test('refuses control characters', () => {
    // Not a Firestore refusal — it would store these quite happily. They are
    // refused because an id nobody can read or type is a corrupt file telling
    // on itself, and because a newline in an id makes every log line that
    // mentions it unreadable.
    expect(isStorableId('a\nb')).toBe(false);
    expect(isStorableId('a\u0000b')).toBe(false);
    expect(isStorableId('a\tb')).toBe(false);
  });
});
