/**
 * When an idle session should end, as a pure decision.
 *
 * Mirrors `exportReminder.ts` and `onboardingGate.ts`: no storage, no React,
 * no event listeners. The rule that decides whether to end someone's session
 * is worth being able to test directly rather than inferring from a render.
 *
 * ## What this protects, and what it does not
 *
 * Signing out clears the Firebase session. It does **not** remove the fuel log
 * from the device: the per-account IndexedDB database is left in place on
 * purpose, so signing back in finds the history and any edits that had not
 * synced yet. So this stops someone casually browsing an unlocked, unattended
 * laptop — it does not stop anyone who opens DevTools, and the UI has to say
 * so. A lock that implies more safety than it delivers is worse than none.
 *
 * The cost is real and goes in the same sentence: signing back in needs a
 * network, so an offline device becomes unusable after the timeout until it
 * reconnects.
 *
 * ## One period, for everyone, always on (#70)
 *
 * It was a per-browser choice, off by default. It is now set once by the
 * administrator — the `VITE_IDLE_TIMEOUT_MINUTES` repository Variable, read at
 * build time (`idleMinutesFromConfig`) — and applies to every user, with no
 * way to turn it off or change it from inside the app. There is deliberately
 * no "off" value: switching the protection off is a code change, not a typo.
 *
 * ## Both failure directions are real
 *
 * Failing *open* — never timing out because a value was garbage or missing —
 * defeats the protection silently, which is the worse of the two because
 * nothing reports it. Failing *closed* — ending a session mid-sentence because
 * a clock moved backwards — destroys trust in it. So every untrusted input is
 * normalised here, once: a nonsense period becomes the default (never
 * "never"), and an unbelievable timestamp restarts the countdown (never
 * "expire now", never "expire never").
 */

/** The period when the administrator has set none, or set one that cannot be read. */
export const DEFAULT_IDLE_MINUTES = 30;

/** Below a minute this is a tripwire, not a timeout. */
export const MIN_IDLE_MINUTES = 1;

/** A day. Past this the setting is doing nothing a reader would notice. */
export const MAX_IDLE_MINUTES = 24 * 60;

const MINUTE_MS = 60 * 1000;

/**
 * A usable period from anything at all.
 *
 * The fallback direction is deliberate: a value that cannot be read becomes
 * `DEFAULT_IDLE_MINUTES`, never "no timeout". A `0` must not be able to turn
 * the timeout into an inert one, because that failure is invisible — nothing
 * ever happens, and nothing says so.
 */
export function normalizeIdleMinutes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_IDLE_MINUTES;
  }
  const whole = Math.trunc(value);
  if (whole < MIN_IDLE_MINUTES) return MIN_IDLE_MINUTES;
  if (whole > MAX_IDLE_MINUTES) return MAX_IDLE_MINUTES;
  return whole;
}

/**
 * The administrator's period, from the raw build-time value.
 *
 * Whole minutes written as plain ASCII digits, optionally padded with spaces:
 * `"45"`, `" 45 "`. Anything else — unset, empty (which is what an unset
 * repository Variable becomes), `"0"`, `"off"`, `"7.5"`, `"1e3"`, `"30min"`
 * — is a mistake, and a mistake gets the default rather than no timeout. A
 * period past a day is held to a day: still on, because a wrong *length* is
 * not a request to switch the protection off.
 */
export function idleMinutesFromConfig(raw: unknown): number {
  if (typeof raw === 'number') return normalizeIdleMinutes(raw);
  if (typeof raw !== 'string') return DEFAULT_IDLE_MINUTES;
  const text = raw.trim();
  if (!/^[0-9]+$/.test(text)) return DEFAULT_IDLE_MINUTES;
  const value = Number(text);
  // Digits only, so a non-finite result is a number too long to represent —
  // an enormous period, which is held to a day like any other.
  return Number.isFinite(value) ? normalizeIdleMinutes(value) : MAX_IDLE_MINUTES;
}

/**
 * A believable last-activity timestamp, or `now`.
 *
 * Unreadable or in the future both restart the countdown. A clock corrected
 * backwards — NTP, a timezone change, a laptop waking from sleep — makes the
 * stored marker newer than the present, and neither alternative is defensible:
 * expiring immediately turns a clock bug into a lockout, and clamping the
 * elapsed time to zero on a far-future value would hold the session open
 * indefinitely. Restarting gives the reader one full period, and the next
 * write puts a real value back.
 *
 * Old values are kept, which is the whole point — "the tab was left open
 * yesterday" is the case this feature exists for.
 */
export function lastActivityFrom(stored: unknown, now: number): number {
  if (typeof stored !== 'number' || !Number.isFinite(stored)) return now;
  return stored > now ? now : stored;
}

/**
 * Whether the timeout has elapsed.
 *
 * Expires **at** the boundary, not after it: "30 minutes" means the session is
 * over at 30:00. A `>` would hold it open for one more poll interval, which is
 * a quiet way for a period to mean something other than what it says.
 */
export function hasIdleTimedOut(minutes: number, lastActivityAt: number, now: number): boolean {
  const since = lastActivityFrom(lastActivityAt, now);
  return now - since >= normalizeIdleMinutes(minutes) * MINUTE_MS;
}

/**
 * Milliseconds left before the timeout fires, or `0` if it already has.
 *
 * Never negative. `setTimeout` treats a negative delay as zero anyway, but
 * returning one invites arithmetic elsewhere that reads as "time left".
 */
export function msUntilIdleTimeout(minutes: number, lastActivityAt: number, now: number): number {
  const since = lastActivityFrom(lastActivityAt, now);
  const deadline = since + normalizeIdleMinutes(minutes) * MINUTE_MS;
  return Math.max(0, deadline - now);
}
