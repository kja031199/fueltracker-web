import type { SchedulerTimers } from '../ui/syncScheduler';

/**
 * Timers a test holds in its hand (#97), for the sync scheduler's existing
 * seam (`SchedulerTimers`).
 *
 * The save-sync delay is a real 1.5 seconds, and tests used to wait it out —
 * `FuelLog.test.tsx` was 46% of the suite's time — or sleep past it to prove a
 * sync did *not* happen, which on a slow machine can let a broken test pass.
 * With these, a test fires the waiting sync when it chooses (`fire`), and
 * proves nothing was scheduled by counting (`pending`), not by sleeping.
 * Not `vi.useFakeTimers()`, which stalls Testing Library's own waiting.
 *
 * @trap #24 — Testing Library looks for Jest's fake timers, not Vitest's, so a
 * blanket fake leaves `findBy*` and `waitFor` polling a timer that never fires,
 * and the test hangs instead of failing. Fake only what the code uses, and
 * before the render.
 *
 * @trap #97 — No test sleeps to prove nothing happened: count it (`pending()`,
 * `world.reads`, a remote's own counter) or wait for something definite. A
 * sleep passes on a slow machine for the wrong reason.
 */
export interface ManualTimers extends SchedulerTimers {
  /** How many timers are waiting. */
  pending(): number;
  /** Runs every waiting timer now, and returns how many ran. */
  fire(): number;
}

export function manualTimers(): ManualTimers {
  let now = 0;
  let nextId = 1;
  const waiting = new Map<number, () => void>();
  return {
    now: () => now,
    setTimeout(fn) {
      const id = nextId++;
      waiting.set(id, fn);
      return id;
    },
    clearTimeout(handle) {
      waiting.delete(handle as number);
    },
    pending: () => waiting.size,
    fire() {
      const due = [...waiting.values()];
      waiting.clear();
      now += 1;
      for (const fn of due) fn();
      return due.length;
    },
  };
}
