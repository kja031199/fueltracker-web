import { describe, expect, test } from 'vitest';
import { FOCUS_SYNC_MIN_INTERVAL_MS, SAVE_SYNC_DELAY_MS, createSyncScheduler } from './syncScheduler';

/**
 * When a sync runs (#52). Two changes:
 *
 * - **After a save.** A new fill-up used to reach the account only on the next
 *   window focus — or never, if the browser's storage was cleared first, which
 *   is the one loss the account exists to prevent.
 * - **Not on every focus.** Each focus was a full read of the account; it is
 *   now at most one sync a minute from focus alone.
 *
 * Pure, with timers injected, so it is tested without a DOM or fake timers.
 */
function harness() {
  let now = 0;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 1;
  const runs: number[] = [];
  let release: (() => void) | null = null;
  let blocking = false;

  const scheduler = createSyncScheduler(
    async () => {
      runs.push(now);
      if (blocking) await new Promise<void>((resolve) => (release = resolve));
    },
    {
      now: () => now,
      setTimeout: (fn, ms) => {
        const id = nextId++;
        timers.push({ at: now + ms, fn, id });
        return id;
      },
      clearTimeout: (id) => {
        const index = timers.findIndex((timer) => timer.id === id);
        if (index !== -1) timers.splice(index, 1);
      },
    },
  );

  async function advance(ms: number): Promise<void> {
    now += ms;
    for (const timer of timers.filter((t) => t.at <= now)) {
      timers.splice(timers.indexOf(timer), 1);
      timer.fn();
    }
    await Promise.resolve();
    await Promise.resolve();
  }

  return {
    scheduler,
    runs,
    advance,
    block: () => (blocking = true),
    finish: async () => {
      blocking = false;
      release?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe('after a save', () => {
  test('syncs shortly afterwards, without waiting for a focus', async () => {
    const { scheduler, runs, advance } = harness();
    scheduler.afterWrite();
    await advance(SAVE_SYNC_DELAY_MS - 1);
    expect(runs).toHaveLength(0);
    await advance(1);
    expect(runs).toHaveLength(1);
  });

  test('several saves in a row become one sync', async () => {
    const { scheduler, runs, advance } = harness();
    scheduler.afterWrite();
    await advance(500);
    scheduler.afterWrite();
    await advance(500);
    scheduler.afterWrite();
    await advance(SAVE_SYNC_DELAY_MS);
    expect(runs).toHaveLength(1);
  });

  test('a save during a running sync is not lost: it runs again afterwards', async () => {
    // The old guard simply returned while a sync was running, so a change made
    // mid-sync waited for the next focus.
    const h = harness();
    h.block();
    void h.scheduler.runNow();
    expect(h.runs).toHaveLength(1);

    h.scheduler.afterWrite();
    await h.advance(SAVE_SYNC_DELAY_MS);
    await h.finish();

    expect(h.runs).toHaveLength(2);
  });
});

describe('on focus', () => {
  test('syncs when the last sync was over a minute ago', async () => {
    const { scheduler, runs, advance } = harness();
    await advance(FOCUS_SYNC_MIN_INTERVAL_MS);
    scheduler.onFocus();
    expect(runs).toHaveLength(1);
  });

  test('does not sync again within a minute of the last one', async () => {
    const { scheduler, runs, advance } = harness();
    await scheduler.runNow();
    await advance(FOCUS_SYNC_MIN_INTERVAL_MS - 1);
    scheduler.onFocus();
    expect(runs).toHaveLength(1);
  });

  test('a minute after the last sync, focus syncs again', async () => {
    const { scheduler, runs, advance } = harness();
    await scheduler.runNow();
    await advance(FOCUS_SYNC_MIN_INTERVAL_MS);
    scheduler.onFocus();
    expect(runs).toHaveLength(2);
  });
});

describe('on request', () => {
  test('"Sync now" and "Try again" are never throttled', async () => {
    const { scheduler, runs } = harness();
    await scheduler.runNow();
    await scheduler.runNow();
    expect(runs).toHaveLength(2);
  });

  test('a request during a running sync waits for it rather than overlapping', async () => {
    const h = harness();
    h.block();
    void h.scheduler.runNow();
    void h.scheduler.runNow();
    expect(h.runs).toHaveLength(1);
    await h.finish();
    expect(h.runs).toHaveLength(2);
  });

  test('nothing runs after dispose', async () => {
    const { scheduler, runs, advance } = harness();
    scheduler.afterWrite();
    scheduler.dispose();
    await advance(SAVE_SYNC_DELAY_MS);
    expect(runs).toHaveLength(0);
  });
});
