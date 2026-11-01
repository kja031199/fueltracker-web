/**
 * A clock that cannot be outbid by a device whose wall clock is wrong.
 *
 * ## The bug this exists to fix
 *
 * Merges are last-write-wins on `updatedAt`, and `updatedAt` was whatever
 * `Date.now()` said on the device that wrote the row. A phone whose clock is a
 * year fast therefore writes rows that beat every other device's edits for a
 * year: the laptop's correction is overwritten on the next pull, and
 * `rowsToPush` then declines to push it because local is no longer greater
 * than remote. The edit does not conflict, does not warn, and does not come
 * back.
 *
 * ## Why a logical clock is safe here
 *
 * `updatedAt` is **never displayed**. Outside the merge machinery nothing reads
 * it — the date a reader sees is the separate `date` field. So it is free to be
 * a logical counter that happens to start at the wall clock, and inflating it
 * costs nothing a person would notice.
 *
 * `now()` returns `max(Date.now(), lastIssued + 1)`, and `observe()` raises the
 * floor to anything already seen. The property that gives us: **a local write
 * is always strictly newer than every row this device has seen**, which is
 * what last-write-wins needs in order to mean "last edit" rather than
 * "furthest-ahead clock".
 *
 * ## Why adoption is bounded
 *
 * A row claiming `Number.MAX_SAFE_INTEGER` would push the floor to the edge of
 * integer precision, where `+ 1` stops producing a larger number — monotonicity
 * would break silently and every later write would tie. So a timestamp is
 * adopted only up to `MAX_ADOPTED_SKEW_MS` beyond the wall clock: generous for
 * any real clock error, nowhere near the precision ceiling.
 *
 * Refusing to adopt means such a row keeps winning, so the refusals are counted
 * and surfaced rather than swallowed. Losing to a row we cannot outbid is bad;
 * losing to it silently is worse.
 */

import type { StoreClock } from './store';

/** Thirty days. A real clock error is hours or days; this is not a race. */
export const MAX_ADOPTED_SKEW_MS = 30 * 24 * 60 * 60 * 1000;

export class MonotonicClock implements StoreClock {
  private lastIssued = 0;
  private refused = 0;

  constructor(
    private readonly wallClock: () => number = Date.now,
    private readonly newIdFn: () => string = () => crypto.randomUUID(),
  ) {}

  /**
   * A timestamp strictly greater than any previously issued or observed.
   *
   * Two writes inside the same millisecond get different values, which matters
   * because `shouldReplace` compares with `>` — equal timestamps mean the
   * second write silently loses.
   */
  now(): number {
    const next = Math.max(this.wallClock(), this.lastIssued + 1);
    this.lastIssued = next;
    return next;
  }

  newId(): string {
    return this.newIdFn();
  }

  /**
   * Raises the floor to a timestamp seen elsewhere, within the bound.
   *
   * Returns false when the value was refused, which is also counted.
   */
  observe(timestamp: unknown): boolean {
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return false;
    if (timestamp <= this.lastIssued) return true;
    if (timestamp > this.wallClock() + MAX_ADOPTED_SKEW_MS) {
      this.refused += 1;
      return false;
    }
    this.lastIssued = timestamp;
    return true;
  }

  /** How many timestamps were too far ahead to adopt. */
  get refusedCount(): number {
    return this.refused;
  }

  /** Called once a refusal has been reported, so it is not reported twice. */
  clearRefusals(): void {
    this.refused = 0;
  }
}

/**
 * The instance the app uses, because one device has one clock.
 *
 * Both the store (which stamps local writes) and the sync engine (which sees
 * remote timestamps) must share it, or the floor the sync engine learns would
 * never reach the writes the store issues. Every consumer takes it as a
 * defaulted parameter so tests inject their own and stay deterministic.
 */
export const sharedSyncClock = new MonotonicClock();
