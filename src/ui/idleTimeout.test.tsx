// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import {
  ACTIVITY_STORAGE_KEY,
  forgetIdleTimeoutSetting,
  loadLastActivity,
  recordActivity,
  useIdleTimeout,
} from './idleTimeout';

/**
 * The storage and the hook around the decision in `domain/idleTimeout.ts`.
 *
 * The rule itself is covered exhaustively there. This file is about the parts
 * that need a browser: does a stale marker end the session on the next load,
 * does real activity hold it open, does a signed-out page truly do nothing,
 * and does a browser that refuses storage still behave.
 */

const MINUTE = 60 * 1000;
const NOW = 1_700_000_000_000;
const ON = 30;

beforeEach(() => {
  localStorage.clear();
  // Only the clock this hook uses. Testing Library detects **Jest's** fake
  // timers, not vitest's, so a blanket `useFakeTimers()` leaves its
  // `findBy*`/`waitFor` polling on a faked `setTimeout` that never fires —
  // which hangs the test rather than failing it. Nothing here uses those
  // helpers today; narrowing it keeps that true for whoever adds one.
  vi.useFakeTimers({ now: NOW, toFake: ['setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('the per-browser setting from before #70', () => {
  // The period is the administrator's now, for everyone. A choice somebody
  // made in this browser earlier — off, or a longer period — must not survive
  // to override it, so it is deleted rather than read.
  test.each([
    ['switched off', '{"enabled":false,"minutes":30}'],
    ['a longer period', '{"enabled":true,"minutes":1440}'],
    ['garbage', 'not json'],
  ])('is removed when it was %s', (_label, raw) => {
    localStorage.setItem('fueltracker.idleTimeout', raw);
    forgetIdleTimeoutSetting();
    expect(localStorage.getItem('fueltracker.idleTimeout')).toBeNull();
  });

  test('removing it leaves the activity marker alone', () => {
    recordActivity();
    localStorage.setItem('fueltracker.idleTimeout', '{"enabled":false}');
    forgetIdleTimeoutSetting();
    expect(localStorage.getItem(ACTIVITY_STORAGE_KEY)).toBe(String(NOW));
  });

  test('removing it survives storage being unavailable', () => {
    const blown = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('private mode');
    });
    expect(() => forgetIdleTimeoutSetting()).not.toThrow();
    blown.mockRestore();
  });
});

describe('the activity marker', () => {
  test('reads as now when there is none', () => {
    expect(loadLastActivity()).toBe(NOW);
  });

  test('round-trips, so another tab sees it', () => {
    recordActivity();
    vi.advanceTimersByTime(5 * MINUTE);
    expect(loadLastActivity()).toBe(NOW);
  });

  test('is a plain timestamp under a documented key, not a blob', () => {
    recordActivity();
    expect(localStorage.getItem(ACTIVITY_STORAGE_KEY)).toBe(String(NOW));
  });

  test('ignores a hand-edited marker in the future', () => {
    localStorage.setItem(ACTIVITY_STORAGE_KEY, String(NOW + 60 * MINUTE));
    expect(loadLastActivity()).toBe(NOW);
  });
});

describe('useIdleTimeout', () => {
  function arm(minutes: number | null): { expired: () => number } {
    const onExpire = vi.fn();
    renderHook(() => useIdleTimeout(minutes, onExpire));
    return { expired: () => onExpire.mock.calls.length };
  }

  test('ends a session that was already idle when the page loaded', () => {
    // The case the feature exists for: the tab was left open and the laptop
    // walked away. Mounting must *check* the stored marker, not reset it —
    // resetting on mount would mean a reload is all it takes to get back in.
    localStorage.setItem(ACTIVITY_STORAGE_KEY, String(NOW - 2 * 60 * MINUTE));
    const session = arm(ON);
    expect(session.expired()).toBe(1);
  });

  test('leaves a fresh session alone', () => {
    localStorage.setItem(ACTIVITY_STORAGE_KEY, String(NOW - MINUTE));
    const session = arm(ON);
    act(() => vi.advanceTimersByTime(20 * MINUTE));
    expect(session.expired()).toBe(0);
  });

  test('ends a session that goes idle while the page is open', () => {
    const session = arm(ON);
    act(() => vi.advanceTimersByTime(31 * MINUTE));
    expect(session.expired()).toBe(1);
  });

  test('activity holds the session open', () => {
    const session = arm(ON);
    act(() => vi.advanceTimersByTime(25 * MINUTE));
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    });
    act(() => vi.advanceTimersByTime(25 * MINUTE));
    expect(session.expired()).toBe(0);

    act(() => vi.advanceTimersByTime(31 * MINUTE));
    expect(session.expired()).toBe(1);
  });

  test('a pointer counts as activity too, not only a keyboard', () => {
    const session = arm(ON);
    act(() => vi.advanceTimersByTime(25 * MINUTE));
    act(() => {
      window.dispatchEvent(new MouseEvent('pointerdown'));
    });
    act(() => vi.advanceTimersByTime(25 * MINUTE));
    expect(session.expired()).toBe(0);
  });

  test('activity in another tab holds this one open', () => {
    // Both tabs read one marker in `localStorage`, so a reader working in the
    // other window is not idle. Keeping this per-tab would sign them out of
    // the tab they left open while they were using the app.
    const session = arm(ON);
    act(() => vi.advanceTimersByTime(25 * MINUTE));
    localStorage.setItem(ACTIVITY_STORAGE_KEY, String(Date.now()));
    act(() => vi.advanceTimersByTime(25 * MINUTE));
    expect(session.expired()).toBe(0);
  });

  test('signs out once, not on every tick afterwards', () => {
    // `signOut()` is a network call and the sign-in screen is already showing
    // by then. Calling it every poll would be a loop nobody asked for.
    const session = arm(ON);
    act(() => vi.advanceTimersByTime(31 * MINUTE));
    act(() => vi.advanceTimersByTime(60 * MINUTE));
    expect(session.expired()).toBe(1);
  });

  test('does nothing at all while nobody is signed in', () => {
    // `null` is how the app says "no session to end": arming it on the sign-in
    // screen would sign out the person trying to sign in.
    const session = arm(null);
    act(() => vi.advanceTimersByTime(7 * 24 * 60 * MINUTE));
    expect(session.expired()).toBe(0);
    expect(localStorage.getItem(ACTIVITY_STORAGE_KEY)).toBeNull();
  });

  test('a shorter period is honoured', () => {
    const session = arm(5);
    act(() => vi.advanceTimersByTime(6 * MINUTE));
    expect(session.expired()).toBe(1);
  });

  test('keeps working when the browser refuses to store the marker', () => {
    // Private mode with storage blocked. If activity cannot be written, it has
    // to be remembered in the tab — otherwise someone typing continuously is
    // signed out mid-sentence, which is the worst failure this feature has.
    const blocked = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    const session = arm(ON);
    act(() => vi.advanceTimersByTime(25 * MINUTE));
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    });
    act(() => vi.advanceTimersByTime(25 * MINUTE));
    expect(session.expired()).toBe(0);
    blocked.mockRestore();
  });

  test('stops watching once unmounted', () => {
    const onExpire = vi.fn();
    const view = renderHook(() => useIdleTimeout(ON, onExpire));
    view.unmount();
    act(() => vi.advanceTimersByTime(60 * MINUTE));
    expect(onExpire).not.toHaveBeenCalled();
  });
});
