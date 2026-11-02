/**
 * Running a sync, and remembering when the last one worked.
 *
 * ## When it runs, and why not more often
 *
 * On mount (so signing in pulls the account down), shortly after every save
 * (so a change reaches the account without waiting for anything), on window
 * focus at most once a minute (so coming back to a tab catches up), and on
 * demand from Settings. `syncScheduler.ts` owns the timing (#52).
 *
 * No realtime listener. The free tier allows 20,000 writes and 50,000 reads a
 * day, which is enormous for one person's fuel log right up until something
 * syncs in a loop — and an app that silently stops working at 4pm because it
 * burned its quota is a worse failure than one that is a few seconds stale.
 * Each sync is also cheap now: it reads only what changed since the last one
 * (`syncState.ts`), not the whole account.
 *
 * ## Failure is a status, not an error
 *
 * `syncOnce` never throws, and this never surfaces a crash. Being unable to
 * reach the account is the normal condition of an offline-first app; the screen
 * says so and the local data carries on working.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RemoteStore } from '../data/remote';
import type { FuelTrackerStore } from '../data/store';
import { syncOnce } from '../data/sync';
import { InMemorySyncState, type SyncStateStore } from '../data/syncState';
import { createSyncScheduler } from './syncScheduler';

const LAST_SYNCED_KEY = 'fueltracker.lastSyncedAt';

/** Reads the stored timestamp. Storage can be unavailable, so this never throws. */
function loadLastSynced(): number | null {
  try {
    const raw = window.localStorage.getItem(LAST_SYNCED_KEY);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function saveLastSynced(at: number): void {
  try {
    window.localStorage.setItem(LAST_SYNCED_KEY, String(at));
  } catch {
    // Private mode with storage blocked. The app still syncs; it just cannot
    // remember when it last did.
  }
}

export interface SyncStatus {
  readonly syncing: boolean;
  readonly lastSyncedAt: number | null;
  /** What happened last time, worth showing. Null when there is nothing to say. */
  readonly message: string | null;
  /**
   * True once the account has **refused** us, as distinct from being out of
   * reach (#40). It will not clear on its own — a refusal is a decision, not a
   * condition — so the app can close itself rather than letting somebody type
   * into a log that will never sync (#41). A successful sync clears it, which
   * is how being added to the allowlist recovers without a reload.
   */
  readonly refused: boolean;
  readonly syncNow: () => Promise<void>;
  /** Call after a local save: syncs shortly, sharing one sync with saves that follow. */
  readonly afterWrite: () => void;
}

export function useSync(
  store: FuelTrackerStore,
  remote: RemoteStore | null,
  /** Called after a sync that changed anything, so the screens reload. */
  onChanged: () => Promise<void>,
  /**
   * Where incremental sync keeps its place — the account's own database in the
   * app (#52). Omitted in tests, where an in-memory one per mount is used.
   */
  syncState?: SyncStateStore,
): SyncStatus {
  const [fallbackState] = useState<SyncStateStore>(() => new InMemorySyncState());
  const state = syncState ?? fallbackState;
  const [syncing, setSyncing] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(() => loadLastSynced());
  const [message, setMessage] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);
  const run = useCallback(async () => {
    if (remote === null) return;
    setSyncing(true);
    try {
      const result = await syncOnce(store, remote, undefined, state);
      if (!result.ok) {
        setMessage(result.reason);
        setRefused(result.kind === 'refused');
        return;
      }
      // A sync that worked is the only thing that can clear a refusal, and it
      // is what makes "ask the owner, then press Try again" recover in place.
      setRefused(false);
      const { pulled, pushed, skippedNewerSchema, invalid, unbeatable, unsendable, repaired, at } =
        result.outcome;
      setLastSyncedAt(at);
      saveLastSynced(at);

      const notes: string[] = [];
      // Two different kinds of bad row, counted together because the reader
      // does not care which: `invalid` failed shape validation, `rejected`
      // passed shape and then failed the draft gate on its numbers.
      const unusable = invalid.length + pulled.rejected.length;
      if (unusable > 0) {
        notes.push(`${unusable} row(s) from your account were unusable and skipped`);
      }
      if (pushed.receiptsOmitted > 0) {
        notes.push(
          `${pushed.receiptsOmitted} receipt photo(s) were too large to sync and stayed on this device`,
        );
      }
      if (unsendable.length > 0) {
        // Named plainly: this one is not a transient network condition, it will
        // not fix itself, and the rows are only on this device until it is
        // dealt with.
        notes.push(
          `${unsendable.length} row(s) could not be uploaded and stay on this device only`,
        );
      }
      if (repaired > 0) {
        notes.push(
          `${repaired} row(s) had text longer than your account accepts and were shortened so they could sync`,
        );
      }
      if (skippedNewerSchema > 0) {
        notes.push(`${skippedNewerSchema} row(s) were written by a newer version and left alone`);
      }
      if (unbeatable > 0) {
        // Said plainly because the consequence is specific and otherwise
        // invisible: edits made here to those rows will not stick.
        notes.push(
          `${unbeatable} row(s) are dated far in the future, probably by a device with a wrong clock — changes you make to those here may not stick until its clock is fixed`,
        );
      }
      setMessage(notes.length === 0 ? null : `Synced. ${notes.join('; ')}.`);

      const changed =
        pulled.vehiclesWritten + pulled.fillUpsWritten + pulled.pendingWritten > 0;
      if (changed || repaired > 0) await onChanged();
    } finally {
      setSyncing(false);
    }
  }, [store, remote, onChanged, state]);

  // One scheduler per mount, always calling the latest `run`. It owns the
  // timing and makes sure two syncs never overlap — a focus landing while the
  // mount sync is in flight would otherwise push the same rows twice.
  const latest = useRef(run);
  latest.current = run;
  const [scheduler] = useState(() => createSyncScheduler(() => latest.current()));
  useEffect(() => () => scheduler.dispose(), [scheduler]);

  // On mount, and whenever the account or store changes.
  useEffect(() => {
    void scheduler.runNow();
  }, [run, scheduler]);

  useEffect(() => {
    function onFocus(): void {
      scheduler.onFocus();
    }
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [scheduler]);

  const syncNow = useCallback(() => scheduler.runNow(), [scheduler]);
  const afterWrite = useCallback(() => scheduler.afterWrite(), [scheduler]);

  return { syncing, lastSyncedAt, message, refused, syncNow, afterWrite };
}
