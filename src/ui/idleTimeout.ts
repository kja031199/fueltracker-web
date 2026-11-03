/**
 * The hook that enforces the idle timeout, and the activity marker it reads.
 *
 * The decision is in `domain/idleTimeout.ts`; this is only storage, events and
 * React. Keeping them apart is what lets the rule be tested without a DOM —
 * the same split `backupNudge.ts` makes over `exportReminder.ts`.
 *
 * ## Not a setting any more (#70)
 *
 * The period is the administrator's (`adminSettings.ts`), the same for
 * everyone, and always on. The per-browser on/off choice that used to live
 * here is deleted at startup by `forgetIdleTimeoutSetting`, never read: an old
 * "off" must not be a way to opt out.
 *
 * ## The activity marker is shared between tabs, deliberately
 *
 * The last-activity timestamp is a **browser** preference read from storage,
 * so two tabs of the app agree. A per-tab timer would sign someone out of the
 * tab they left open *while they were using the app in the other one*, which
 * is indistinguishable from a bug.
 */

import { useEffect, useRef } from 'react';
import { hasIdleTimedOut, lastActivityFrom } from '../domain/idleTimeout';
import {
  browserPreference,
  numberCodec,
  readPreference,
  removePreference,
  storageKey,
  writePreference,
} from './preferences';

/**
 * The per-browser choice from before #70: on or off, and a period. The period
 * is the administrator's now, so this is only ever **deleted** — never read,
 * because reading it is how an old "off" would switch the protection off.
 */
const LEGACY_SETTING = browserPreference<never>('idleTimeout', {
  decode: () => null,
  encode: () => '',
});

/** Deletes the pre-#70 per-browser setting. Called once as the app starts. */
export function forgetIdleTimeoutSetting(): void {
  removePreference(LEGACY_SETTING);
}

/** Browser-wide on purpose: every tab, whoever is signed in, shares one clock. */
const ACTIVITY = browserPreference('lastActivity', numberCodec);

/** Exported so a test can assert the stored shape rather than guess at it. */
export const ACTIVITY_STORAGE_KEY = storageKey(ACTIVITY);

/**
 * How often the deadline is checked.
 *
 * Polling rather than one armed `setTimeout`, because the deadline moves: it is
 * recomputed from a marker that another tab may have refreshed, and a laptop
 * that slept through its own timeout should notice on waking rather than when a
 * timer that was never running fires.
 */
export const IDLE_POLL_MS = 15 * 1000;

/**
 * Activity is written at most this often.
 *
 * Someone typing produces a `keydown` per character; a `localStorage` write per
 * character is synchronous main-thread work for no gain. The in-tab watermark
 * is updated every time regardless, so throttling costs only how quickly
 * *another* tab learns about it.
 */
const WRITE_THROTTLE_MS = 5 * 1000;

/** The events that count as "still here". */
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel'] as const;

/** The stored marker as a finite number, or `null` if there is not one. */
function readActivityMarker(): number | null {
  return readPreference(ACTIVITY);
}

/**
 * The last recorded activity, or `now` when there is no believable marker.
 *
 * "No marker" means this page just started with nothing stored, which is
 * activity by definition — somebody opened it.
 */
export function loadLastActivity(now: number = Date.now()): number {
  return lastActivityFrom(readActivityMarker(), now);
}

/**
 * Storage blocked: see `useIdleTimeout` — the in-tab watermark is what keeps a
 * reader whose browser refuses storage from being signed out mid-sentence.
 */
export function recordActivity(now: number = Date.now()): void {
  writePreference(ACTIVITY, now);
}

/**
 * Nothing depends on this succeeding: a stale marker only ever shortens the
 * next session, never extends it.
 */
export function clearActivity(): void {
  removePreference(ACTIVITY);
}

/**
 * Signs the reader out after `minutes` of inactivity.
 *
 * `null` means there is no session to end — nobody is signed in — and then it
 * does **nothing at all**: no listeners, no timer, no stored marker. Arming it
 * on the sign-in screen would sign out the person trying to sign in.
 *
 * `onExpire` is called at most once per arming. It is a network call, and by
 * the time it has run the sign-in screen is already showing — calling it on
 * every subsequent tick would be a loop nobody asked for. Any activity re-arms
 * it, which is what lets someone sign back in and get a fresh period without
 * reloading the page.
 */
export function useIdleTimeout(minutes: number | null, onExpire: () => void): void {
  // Held in a ref so a changing callback identity does not tear down the
  // listeners and restart the countdown on every render.
  const expire = useRef(onExpire);
  expire.current = onExpire;

  useEffect(() => {
    if (minutes === null) return;
    const period = minutes;

    // The in-tab watermark. It exists for the browser that refuses storage: if
    // activity cannot be written, it has to be remembered here, or someone
    // typing continuously is signed out mid-sentence — the worst failure this
    // feature has. On mount it is read *from* storage rather than set to now,
    // because a reload must not be all it takes to get back in.
    let lastActivity = loadLastActivity(Date.now());
    let lastWrite = 0;
    let fired = false;

    recordActivity(lastActivity);
    lastWrite = Date.now();

    function since(now: number): number {
      const stored = readActivityMarker();
      // A watermark, so another tab's fresher write wins and a blocked write
      // does not lose this tab's own activity.
      const merged = stored === null ? lastActivity : Math.max(lastActivity, stored);
      return lastActivityFrom(merged, now);
    }

    function check(): void {
      if (fired) return;
      const now = Date.now();
      if (!hasIdleTimedOut(period, since(now), now)) return;
      fired = true;
      expire.current();
    }

    function onActivity(): void {
      const now = Date.now();
      lastActivity = now;
      // Re-armed, so signing back in during this page session gets a fresh
      // period instead of a dead timeout.
      fired = false;
      if (now - lastWrite < WRITE_THROTTLE_MS) return;
      lastWrite = now;
      recordActivity(now);
    }

    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, onActivity, { passive: true });
    }
    // Returning to the tab is not activity — browsing someone's open laptop is
    // exactly the case this guards — but it is a good moment to check, so the
    // sign-out is immediate rather than up to one poll late.
    document.addEventListener('visibilitychange', check);

    // Checked before the first tick, so a page loaded after a long absence
    // does not show the fuel log for fifteen seconds first.
    check();
    const timer = setInterval(check, IDLE_POLL_MS);

    return () => {
      clearInterval(timer);
      for (const event of ACTIVITY_EVENTS) window.removeEventListener(event, onActivity);
      document.removeEventListener('visibilitychange', check);
    };
  }, [minutes]);
}
