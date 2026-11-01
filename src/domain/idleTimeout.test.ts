import { describe, expect, test } from 'vitest';
import {
  DEFAULT_IDLE_MINUTES,
  IDLE_MINUTE_CHOICES,
  IDLE_TIMEOUT_OFF,
  MAX_IDLE_MINUTES,
  MIN_IDLE_MINUTES,
  hasIdleTimedOut,
  lastActivityFrom,
  msUntilIdleTimeout,
  normalizeIdleMinutes,
} from './idleTimeout';

/**
 * The idle-timeout decision, as a pure rule.
 *
 * Mirrors `exportReminder.ts` and `onboardingGate.ts`: no storage, no React,
 * no event listeners, so the thing that decides whether to end someone's
 * session can be tested rather than inferred from a render.
 *
 * The bar for this one is higher than for the backup nudge, because both
 * failure directions are real. Failing *open* — never timing out because a
 * stored value was garbage — defeats the feature silently. Failing *closed* —
 * signing someone out mid-sentence because a clock moved — destroys trust in a
 * setting that was optional to begin with.
 */

const MINUTE = 60 * 1000;
const NOW = 1_700_000_000_000;
const ON = { enabled: true, minutes: 30 };

describe('the default', () => {
  test('is off', () => {
    // The issue's acceptance criterion, and the iOS original's choice for
    // `AppLock`. An app that starts signing people out without being asked is
    // a bug report, not a security feature.
    expect(IDLE_TIMEOUT_OFF.enabled).toBe(false);
  });

  test('carries a sensible period for when it is switched on', () => {
    expect(IDLE_TIMEOUT_OFF.minutes).toBe(DEFAULT_IDLE_MINUTES);
    expect(IDLE_MINUTE_CHOICES).toContain(DEFAULT_IDLE_MINUTES);
  });
});

describe('hasIdleTimedOut', () => {
  test('is false while the session is still fresh', () => {
    expect(hasIdleTimedOut(ON, NOW - 5 * MINUTE, NOW)).toBe(false);
  });

  test('is true once the period has passed', () => {
    expect(hasIdleTimedOut(ON, NOW - 31 * MINUTE, NOW)).toBe(true);
  });

  test('expires exactly at the boundary, not a tick after it', () => {
    // Stated rather than left to chance: "30 minutes" means the session is
    // over at 30:00. A `>` here would hold the session open for one more poll
    // interval, which is a quiet way for a setting to mean something other
    // than what it says.
    expect(hasIdleTimedOut(ON, NOW - 30 * MINUTE, NOW)).toBe(true);
    expect(hasIdleTimedOut(ON, NOW - 30 * MINUTE + 1, NOW)).toBe(false);
  });

  test('never fires while the setting is off, however old the activity is', () => {
    expect(hasIdleTimedOut(IDLE_TIMEOUT_OFF, NOW - 400 * 24 * 60 * MINUTE, NOW)).toBe(false);
  });

  test('does not fire on a last activity in the future', () => {
    // A clock corrected backwards — NTP, a timezone fiddle, a laptop waking
    // from sleep — makes the stored marker newer than the present. Signing
    // someone out for that would be a clock bug presenting as a lockout.
    expect(hasIdleTimedOut(ON, NOW + 60 * MINUTE, NOW)).toBe(false);
  });

  test('does not fire on an identical timestamp', () => {
    expect(hasIdleTimedOut(ON, NOW, NOW)).toBe(false);
  });

  test('treats a nonsense period as the default rather than as "never"', () => {
    // The direction that matters. A hand-edited or older-build value must not
    // be able to turn an enabled timeout into an inert one.
    for (const minutes of [0, -30, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(hasIdleTimedOut({ enabled: true, minutes }, NOW - 31 * MINUTE, NOW)).toBe(true);
      expect(hasIdleTimedOut({ enabled: true, minutes }, NOW - MINUTE, NOW)).toBe(false);
    }
  });

  test('treats a non-finite last activity as activity now', () => {
    expect(hasIdleTimedOut(ON, Number.NaN, NOW)).toBe(false);
  });
});

describe('msUntilIdleTimeout', () => {
  test('is null when the setting is off, so no timer is ever armed', () => {
    expect(msUntilIdleTimeout(IDLE_TIMEOUT_OFF, NOW, NOW)).toBeNull();
  });

  test('counts down from the last activity', () => {
    expect(msUntilIdleTimeout(ON, NOW - 10 * MINUTE, NOW)).toBe(20 * MINUTE);
  });

  test('is zero rather than negative once the period has passed', () => {
    // The caller feeds this to `setTimeout`, which treats a negative delay as
    // zero anyway — but returning a negative number invites arithmetic that
    // reads as "there is still time left".
    expect(msUntilIdleTimeout(ON, NOW - 90 * MINUTE, NOW)).toBe(0);
  });

  test('gives a full period for a last activity in the future', () => {
    expect(msUntilIdleTimeout(ON, NOW + 10 * MINUTE, NOW)).toBe(30 * MINUTE);
  });
});

describe('normalizeIdleMinutes', () => {
  test('keeps an offered choice unchanged', () => {
    for (const minutes of IDLE_MINUTE_CHOICES) {
      expect(normalizeIdleMinutes(minutes)).toBe(minutes);
    }
  });

  test('accepts a plausible period that is not one of the offered choices', () => {
    // The select offers four, but a stored 45 is a perfectly sane period and
    // rejecting it would silently change a reader's setting.
    expect(normalizeIdleMinutes(45)).toBe(45);
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
