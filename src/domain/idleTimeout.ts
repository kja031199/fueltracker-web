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
 * reconnects. That is why this is **off by default** — the iOS original made
 * the same call for `AppLock`.
 *
 * ## Both failure directions are real
 *
 * Failing *open* — never timing out because a stored value was garbage —
 * defeats the feature silently, which is the worse of the two because nothing
 * reports it. Failing *closed* — ending a session mid-sentence because a clock
 * moved backwards — destroys trust in a setting that was optional anyway. So
 * every untrusted input is normalised here, once, rather than at each caller:
 * a nonsense period becomes the default (never "never"), and an unbelievable
 * timestamp restarts the countdown (never "expire now", never "expire never").
 */

/** The period used when the setting is switched on, and whenever one is unreadable. */
export const DEFAULT_IDLE_MINUTES = 30;

/** What Settings offers. Any stored value in range is still honoured. */
export const IDLE_MINUTE_CHOICES = [5, 15, 30, 60] as const;

/** Below a minute this is a tripwire, not a timeout. */
export const MIN_IDLE_MINUTES = 1;

/** A day. Past this the setting is doing nothing a reader would notice. */
export const MAX_IDLE_MINUTES = 24 * 60;

const MINUTE_MS = 60 * 1000;

export interface IdleTimeoutSetting {
  readonly enabled: boolean;
  /** Minutes of inactivity before signing out. Only read when `enabled`. */
  readonly minutes: number;
}

/**
 * The shipped default: off.
 *
 * It still carries a period, so switching the setting on does not also require
 * picking one — the reader gets a sensible answer and can change it.
 */
export const IDLE_TIMEOUT_OFF: IdleTimeoutSetting = {
  enabled: false,
  minutes: DEFAULT_IDLE_MINUTES,
};

/**
 * A usable period from anything at all.
 *
 * The fallback direction is deliberate: a value that cannot be read becomes
 * `DEFAULT_IDLE_MINUTES`, never "no timeout". A hand-edited `0` or a field
 * written by an older build must not be able to turn an enabled timeout into
 * an inert one, because that failure is invisible — the setting still reads as
 * on, and nothing ever happens.
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
 * Whether an enabled timeout has elapsed.
 *
 * Expires **at** the boundary, not after it: "30 minutes" means the session is
 * over at 30:00. A `>` would hold it open for one more poll interval, which is
 * a quiet way for a setting to mean something other than what it says.
 */
export function hasIdleTimedOut(
  setting: IdleTimeoutSetting,
  lastActivityAt: number,
  now: number,
): boolean {
  if (!setting.enabled) return false;
  const since = lastActivityFrom(lastActivityAt, now);
  return now - since >= normalizeIdleMinutes(setting.minutes) * MINUTE_MS;
}

/**
 * Milliseconds left before the timeout fires, `0` if it already has, or `null`
 * when the setting is off — so a caller can arm a single timer rather than
 * polling, and arms nothing at all when the feature is disabled.
 *
 * Never negative. `setTimeout` treats a negative delay as zero anyway, but
 * returning one invites arithmetic elsewhere that reads as "time left".
 */
export function msUntilIdleTimeout(
  setting: IdleTimeoutSetting,
  lastActivityAt: number,
  now: number,
): number | null {
  if (!setting.enabled) return null;
  const since = lastActivityFrom(lastActivityAt, now);
  const deadline = since + normalizeIdleMinutes(setting.minutes) * MINUTE_MS;
  return Math.max(0, deadline - now);
}
