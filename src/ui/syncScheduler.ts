/**
 * When a sync runs (#52).
 *
 * - **After a save**, shortly: a change used to reach the account only on the
 *   next window focus, or never if the browser's storage was cleared first —
 *   the one loss the account exists to prevent. Saves in quick succession
 *   (an import, a fill-up and its vehicle) share one sync.
 * - **On focus**, at most once a minute. Each focus used to be a full read of
 *   the account; switching tabs a dozen times was a dozen reads.
 * - **On request** — "Sync now", "Try again", mount — immediately, never
 *   throttled: somebody asked.
 *
 * Never two at once. A request while one is running waits for it and then runs
 * once more, so a change made mid-sync is not left for the next focus — the
 * old guard simply returned, and it was.
 *
 * Pure, with its clock and timers injected, so it is tested without a DOM.
 */

export const SAVE_SYNC_DELAY_MS = 1_500;
export const FOCUS_SYNC_MIN_INTERVAL_MS = 60_000;

export interface SchedulerTimers {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const browserTimers: SchedulerTimers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface SyncScheduler {
  /** Sync now, or straight after the one already running. */
  runNow(): Promise<void>;
  /** A save happened: sync shortly, sharing one sync with any saves that follow. */
  afterWrite(): void;
  /** The window regained focus: sync unless one started within the last minute. */
  onFocus(): void;
  /** Cancels anything pending; nothing runs afterwards. */
  dispose(): void;
}

export function createSyncScheduler(run: () => Promise<void>, timers: SchedulerTimers = browserTimers): SyncScheduler {
  let timer: unknown = null;
  let current: Promise<void> | null = null;
  let again = false;
  let disposed = false;
  let lastStartedAt = Number.NEGATIVE_INFINITY;

  function clearTimer(): void {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
  }

  function runNow(): Promise<void> {
    if (disposed) return Promise.resolve();
    clearTimer();
    if (current !== null) {
      again = true;
      return current;
    }
    lastStartedAt = timers.now();
    current = (async () => {
      try {
        await run();
      } finally {
        current = null;
        if (again && !disposed) {
          again = false;
          void runNow();
        }
      }
    })();
    return current;
  }

  return {
    runNow,
    afterWrite(): void {
      if (disposed) return;
      clearTimer();
      timer = timers.setTimeout(() => {
        timer = null;
        void runNow();
      }, SAVE_SYNC_DELAY_MS);
    },
    onFocus(): void {
      if (timers.now() - lastStartedAt < FOCUS_SYNC_MIN_INTERVAL_MS) return;
      void runNow();
    },
    dispose(): void {
      disposed = true;
      clearTimer();
    },
  };
}
