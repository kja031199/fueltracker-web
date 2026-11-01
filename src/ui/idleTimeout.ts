/**
 * Where the idle-timeout setting lives, and the hook that enforces it.
 *
 * The decision is in `domain/idleTimeout.ts`; this is only storage, events and
 * React. Keeping them apart is what lets the rule be tested without a DOM —
 * the same split `backupNudge.ts` makes over `exportReminder.ts`.
 *
 * ## Per device, and per device on purpose
 *
 * `localStorage`, not a synced field. Whether this browser signs itself out is
 * a property of *this* machine: a shared laptop wants it on, a phone that is
 * already locked by its owner's face does not. Syncing it would also mean a
 * new synced field, which the `hasOnly` rule in `firestore.rules` makes a
 * two-part deploy — for a setting nobody wants shared.
 *
 * ## The activity marker is shared between tabs, deliberately
 *
 * Both the setting and the last-activity timestamp are read from storage, so
 * two tabs of the app agree. A per-tab timer would sign someone out of the tab
 * they left open *while they were using the app in the other one*, which is
 * indistinguishable from a bug.
 *
 * ## Fallbacks point in two different directions, which is not an accident
 *
 * An unreadable **period** falls back to the default, because the reader's
 * consent is legible and only the number is broken — reading it as "off" would
 * let a storage glitch switch off a protection somebody asked for. An
 * unreadable **setting** falls back to off, because there is then no evidence
 * of consent at all, and signing someone out of their own app on the strength
 * of corrupt data is an action they never requested. See
 * `domain/idleTimeout.ts` for the same reasoning about timestamps.
 */

import { useEffect, useRef } from 'react';
import type { IdleTimeoutSetting } from '../domain/idleTimeout';
import {
  IDLE_TIMEOUT_OFF,
  hasIdleTimedOut,
  lastActivityFrom,
  normalizeIdleMinutes,
} from '../domain/idleTimeout';

const SETTING_STORAGE_KEY = 'fueltracker.idleTimeout';

/** Exported so a test can assert the stored shape rather than guess at it. */
export const ACTIVITY_STORAGE_KEY = 'fueltracker.lastActivity';

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

export function loadIdleTimeoutSetting(): IdleTimeoutSetting {
  try {
    const raw = window.localStorage.getItem(SETTING_STORAGE_KEY);
    if (raw === null) return IDLE_TIMEOUT_OFF;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return IDLE_TIMEOUT_OFF;
    const candidate = parsed as Record<string, unknown>;
    if (typeof candidate['enabled'] !== 'boolean') return IDLE_TIMEOUT_OFF;
    return {
      enabled: candidate['enabled'],
      minutes: normalizeIdleMinutes(candidate['minutes']),
    };
  } catch {
    return IDLE_TIMEOUT_OFF;
  }
}

export function saveIdleTimeoutSetting(setting: IdleTimeoutSetting): void {
  try {
    window.localStorage.setItem(SETTING_STORAGE_KEY, JSON.stringify(setting));
  } catch {
    // Storage blocked. The setting then lasts only as long as the tab, which
    // is the right way for this particular failure to degrade — it does not
    // silently stay on.
  }
}

/** The stored marker as a finite number, or `null` if there is not one. */
function readActivityMarker(): number | null {
  try {
    const raw = window.localStorage.getItem(ACTIVITY_STORAGE_KEY);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
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

export function recordActivity(now: number = Date.now()): void {
  try {
    window.localStorage.setItem(ACTIVITY_STORAGE_KEY, String(now));
  } catch {
    // See `useIdleTimeout`: the in-tab watermark is what keeps a reader whose
    // browser refuses storage from being signed out mid-sentence.
  }
}

export function clearActivity(): void {
  try {
    window.localStorage.removeItem(ACTIVITY_STORAGE_KEY);
  } catch {
    // Nothing to do, and nothing depends on it: a stale marker only ever
    // shortens the next session, never extends it.
  }
}

/**
 * Signs the reader out after a period of inactivity, when they have asked for
 * that.
 *
 * Does **nothing at all** while the setting is off: no listeners, no timer, no
 * stored marker. A disabled feature should leave no trace to explain later.
 *
 * `onExpire` is called at most once per arming. It is a network call, and by
 * the time it has run the sign-in screen is already showing — calling it on
 * every subsequent tick would be a loop nobody asked for. Any activity re-arms
 * it, which is what lets someone sign back in and get a fresh period without
 * reloading the page.
 */
export function useIdleTimeout(setting: IdleTimeoutSetting, onExpire: () => void): void {
  // Held in a ref so a changing callback identity does not tear down the
  // listeners and restart the countdown on every render.
  const expire = useRef(onExpire);
  expire.current = onExpire;

  const { enabled, minutes } = setting;

  useEffect(() => {
    if (!enabled) return;

    const effective: IdleTimeoutSetting = { enabled: true, minutes };

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
      if (!hasIdleTimedOut(effective, since(now), now)) return;
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
  }, [enabled, minutes]);
}
