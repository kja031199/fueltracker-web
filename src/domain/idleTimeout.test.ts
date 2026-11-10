import { describe, expect, test } from 'vitest';
import {
  DEFAULT_IDLE_MINUTES,
  MAX_IDLE_MINUTES,
  MIN_IDLE_MINUTES,
  hasIdleTimedOut,
  idleMinutesFromConfig,
  lastActivityFrom,
  normalizeIdleMinutes,
} from './idleTimeout';

/**
 * The idle-timeout decision, as a pure rule.
 *
 * Mirrors `exportReminder.ts` and `onboardingGate.ts`: no storage, no React,
 * no event listeners, so the thing that decides whether to end someone's
 * session can be tested rather than inferred from a render.
 *
 * Since #70 the period is set once, by the administrator, for everyone, and
 * there is no "off". So the failure direction that matters most is failing
 * *open*: a typo or a forgotten setting must not quietly remove the
 * protection. Every unreadable value becomes the default, never "never".
 */

const MINUTE = 60 * 1000;
const NOW = 1_700_000_000_000;
const PERIOD = 30;

describe('the administrator\'s value', () => {
  test.each([
    ['30', 30],
    ['45', 45],
    [' 45 ', 45],
    ['00045', 45],
    ['1', 1],
    ['1440', 1440],
  ])('reads %j as %i minutes', (raw, minutes) => {
    expect(idleMinutesFromConfig(raw)).toBe(minutes);
  });

  test('a number is accepted as well as text', () => {
    expect(idleMinutesFromConfig(45)).toBe(45);
  });

  test.each([
    ['unset', undefined],
    ['empty (an unset repository Variable)', ''],
    ['blank', '   '],
    ['zero', '0'],
    ['negative', '-5'],
    ['a word', 'thirty'],
    ['"off" — there is no off (#70)', 'off'],
    ['"never"', 'never'],
    ['"false"', 'false'],
    ['a unit suffix', '30min'],
    ['a fraction', '7.5'],
    ['exponent notation', '1e3'],
    ['hex', '0x1E'],
    ['Infinity', 'Infinity'],
    ['NaN', 'NaN'],
    ['non-ASCII digits', '\u0663\u0660'],
    ['two numbers', '30 60'],
    ['null', null],
    ['an object', { minutes: 30 }],
    ['NaN as a number', Number.NaN],
    ['zero as a number', 0],
  ])('falls back to the default for %s — never to "no timeout"', (_label, raw) => {
    expect(idleMinutesFromConfig(raw)).toBe(DEFAULT_IDLE_MINUTES);
  });

  test('a period past a day is held to a day, not dropped', () => {
    // Still on: an absurd value is a mistake about *how long*, not a request
    // to switch the protection off.
    expect(idleMinutesFromConfig('99999')).toBe(MAX_IDLE_MINUTES);
    expect(idleMinutesFromConfig('9'.repeat(400))).toBe(MAX_IDLE_MINUTES);
  });

  test('the default is a sensible half hour', () => {
    expect(DEFAULT_IDLE_MINUTES).toBe(30);
  });
});

describe('hasIdleTimedOut', () => {
  test('is false while the session is still fresh', () => {
    expect(hasIdleTimedOut(PERIOD, NOW - 5 * MINUTE, NOW)).toBe(false);
  });

  test('is true once the period has passed', () => {
    expect(hasIdleTimedOut(PERIOD, NOW - 31 * MINUTE, NOW)).toBe(true);
  });

  test('expires exactly at the boundary, not a tick after it', () => {
    // "30 minutes" means the session is over at 30:00. A `>` here would hold
    // it open for one more poll interval.
    expect(hasIdleTimedOut(PERIOD, NOW - 30 * MINUTE, NOW)).toBe(true);
    expect(hasIdleTimedOut(PERIOD, NOW - 30 * MINUTE + 1, NOW)).toBe(false);
  });

  test('a long absence always ends the session — there is no off', () => {
    expect(hasIdleTimedOut(PERIOD, NOW - 400 * 24 * 60 * MINUTE, NOW)).toBe(true);
  });

  test('does not fire on a last activity in the future', () => {
    // A clock corrected backwards makes the stored marker newer than the
    // present. Signing someone out for that is a clock bug as a lockout.
    expect(hasIdleTimedOut(PERIOD, NOW + 60 * MINUTE, NOW)).toBe(false);
  });

  test('does not fire on an identical timestamp', () => {
    expect(hasIdleTimedOut(PERIOD, NOW, NOW)).toBe(false);
  });

  test('treats a nonsense period as the default rather than as "never"', () => {
    for (const minutes of [0, -30, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(hasIdleTimedOut(minutes, NOW - 31 * MINUTE, NOW)).toBe(true);
      expect(hasIdleTimedOut(minutes, NOW - MINUTE, NOW)).toBe(false);
    }
  });

  test('treats a non-finite last activity as activity now', () => {
    expect(hasIdleTimedOut(PERIOD, Number.NaN, NOW)).toBe(false);
  });
});

describe('normalizeIdleMinutes', () => {
  test('keeps a plausible period unchanged', () => {
    for (const minutes of [5, 15, 30, 45, 60]) expect(normalizeIdleMinutes(minutes)).toBe(minutes);
  });

  test.each([
    ['zero', 0],
    ['negative', -5],
    ['not a number', 'thirty'],
    ['null', null],
    ['undefined', undefined],
    ['NaN', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
    ['an object', { minutes: 30 }],
  ])('falls back to the default for %s', (_label, value) => {
    expect(normalizeIdleMinutes(value)).toBe(DEFAULT_IDLE_MINUTES);
  });

  test('clamps a period nobody could have meant', () => {
    expect(normalizeIdleMinutes(10_000_000)).toBe(MAX_IDLE_MINUTES);
    expect(normalizeIdleMinutes(0.4)).toBe(MIN_IDLE_MINUTES);
  });

  test('truncates a fractional period to whole minutes', () => {
    expect(normalizeIdleMinutes(30.7)).toBe(30);
  });
});

describe('lastActivityFrom', () => {
  test('keeps a believable stored timestamp', () => {
    expect(lastActivityFrom(NOW - 5 * MINUTE, NOW)).toBe(NOW - 5 * MINUTE);
  });

  test.each([
    ['nothing stored', null],
    ['text', 'just now'],
    ['NaN', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
    ['an object', {}],
  ])('restarts the countdown when the stored value is %s', (_label, value) => {
    // Not "expire immediately" and not "never expire": both would be a storage
    // problem deciding a security question. Restarting means the reader gets
    // one full period, and the next write puts a real value back.
    expect(lastActivityFrom(value, NOW)).toBe(NOW);
  });

  test('restarts the countdown for a timestamp in the future', () => {
    expect(lastActivityFrom(NOW + 60 * MINUTE, NOW)).toBe(NOW);
  });

  test('keeps an old-but-believable timestamp, which is the whole point', () => {
    // The case the feature exists for: the tab was left open yesterday. This
    // value must survive, or nothing ever times out.
    expect(lastActivityFrom(NOW - 24 * 60 * MINUTE, NOW)).toBe(NOW - 24 * 60 * MINUTE);
  });
});
