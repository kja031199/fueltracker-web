// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import {
  DEFAULT_IDLE_MINUTES,
  IDLE_TIMEOUT_OFF,
  type IdleTimeoutSetting,
} from '../domain/idleTimeout';
import {
  ACTIVITY_STORAGE_KEY,
  loadIdleTimeoutSetting,
  loadLastActivity,
  recordActivity,
  saveIdleTimeoutSetting,
  useIdleTimeout,
} from './idleTimeout';

/**
 * The storage and the hook around the decision in `domain/idleTimeout.ts`.
 *
 * The rule itself is covered exhaustively there. This file is about the parts
 * that need a browser: does a stale marker end the session on the next load,
 * does real activity hold it open, does a disabled setting truly do nothing,
 * and does a browser that refuses storage still behave.
 */

const MINUTE = 60 * 1000;
const NOW = 1_700_000_000_000;
const ON: IdleTimeoutSetting = { enabled: true, minutes: 30 };

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

describe('the stored setting', () => {
  test('is off when nothing has ever been stored', () => {
    expect(loadIdleTimeoutSetting()).toEqual(IDLE_TIMEOUT_OFF);
  });

  test('round-trips', () => {
    saveIdleTimeoutSetting({ enabled: true, minutes: 15 });
    expect(loadIdleTimeoutSetting()).toEqual({ enabled: true, minutes: 15 });
  });

  test('keeps an enabled setting whose period is unreadable, with the default period', () => {
    // The reader's consent was recorded and is legible; only the number is
    // broken. Reading this as "off" would be a storage glitch switching off a
    // protection somebody asked for.
    localStorage.setItem('fueltracker.idleTimeout', JSON.stringify({ enabled: true, minutes: 0 }));
    expect(loadIdleTimeoutSetting()).toEqual({ enabled: true, minutes: DEFAULT_IDLE_MINUTES });
  });

  test.each([
    ['text that is not JSON', 'not json'],
    ['a JSON string', '"on"'],
    ['null', 'null'],
    ['an object with no enabled flag', '{"minutes":30}'],
  ])('falls back to off for %s', (_label, raw) => {
    // The other direction from the period above, on purpose. With no legible
    // record that the reader turned this on, signing them out is an action
    // they never asked for — and the device lock they should already have is
    // the stronger protection anyway.
    localStorage.setItem('fueltracker.idleTimeout', raw);
    expect(loadIdleTimeoutSetting()).toEqual(IDLE_TIMEOUT_OFF);
  });

  test('survives storage being unavailable', () => {
    const blown = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('private mode');
    });
    expect(loadIdleTimeoutSetting()).toEqual(IDLE_TIMEOUT_OFF);
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
  function arm(setting: IdleTimeoutSetting): { expired: () => number } {
    const onExpire = vi.fn();
    renderHook(() => useIdleTimeout(setting, onExpire));
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

  test('does nothing at all while the setting is off', () => {
    const session = arm(IDLE_TIMEOUT_OFF);
    act(() => vi.advanceTimersByTime(7 * 24 * 60 * MINUTE));
    expect(session.expired()).toBe(0);
    // And it writes no marker: a disabled feature should leave no trace to
    // explain later.
    expect(localStorage.getItem(ACTIVITY_STORAGE_KEY)).toBeNull();
  });

  test('a shorter period is honoured', () => {
    const session = arm({ enabled: true, minutes: 5 });
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
