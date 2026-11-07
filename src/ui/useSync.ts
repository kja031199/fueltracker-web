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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RemoteStore } from '../data/remote';
import type { FuelTrackerStore } from '../data/store';
import { syncAll, type SharingSync } from '../data/shareSync';
import type { SyncOutcome } from '../data/sync';
import { sharedSyncClock } from '../data/syncClock';
import { InMemorySyncState, type SyncStateStore } from '../data/syncState';
import { createSyncScheduler } from './syncScheduler';
import { accountPreference, numberCodec, useAccountPreference } from './preferences';

/**
 * When a sync last worked — an **account** preference (#55). Browser-wide, it
 * showed one account the time of another account's sync. Storage blocked: the
 * app still syncs, it just cannot remember when it last did.
 */
const LAST_SYNCED = accountPreference('lastSyncedAt', numberCodec);

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
  /** The signed-in uid, whose last-synced time this is. Null when signed out. */
  account: string | null = null,
  /**
   * Cars shared with and by this account (#66): each shared car is synced
   * with its owner's account after this account's own sync. Null without one.
   */
  sharing: SharingSync | null = null,
): SyncStatus {
  const [fallbackState] = useState<SyncStateStore>(() => new InMemorySyncState());
  const state = syncState ?? fallbackState;
  const [syncing, setSyncing] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useAccountPreference(LAST_SYNCED, account, null);
  const [message, setMessage] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);
  const run = useCallback(async () => {
    if (remote === null) return;
    setSyncing(true);
    try {
      const all = await syncAll(store, remote, sharing, sharedSyncClock, state);
      const result = all.own;
      if (!result.ok) {
        setMessage(result.reason);
        setRefused(result.kind === 'refused');
        return;
      }
      // A sync that worked is the only thing that can clear a refusal, and it
      // is what makes "ask the owner, then press Try again" recover in place.
      setRefused(false);
      const { pulled, repaired, at } = result.outcome;
      // The account's own sync and every shared car's (#84): what one reports,
      // all report — a photo too large on a shared car is as much a photo
      // stuck on this device as one on your own.
      const every: readonly SyncOutcome[] = [result.outcome, ...all.shares.outcomes];
      const total = (count: (outcome: SyncOutcome) => number): number =>
        every.reduce((sum, outcome) => sum + count(outcome), 0);
      const invalid = total((o) => o.invalid.length);
      const skippedNewerSchema = total((o) => o.skippedNewerSchema);
      const unbeatable = total((o) => o.unbeatable);
      const unsendable = total((o) => o.unsendable.length);
      const receiptsOmitted = total((o) => o.pushed.receiptsOmitted);
      const pulledRejected = total((o) => o.pulled.rejected.length);
      setLastSyncedAt(at);

      const notes: string[] = [];
      // Two different kinds of bad row, counted together because the reader
      // does not care which: `invalid` failed shape validation, `rejected`
      // passed shape and then failed the draft gate on its numbers.
      const unusable = invalid + pulledRejected;
      if (unusable > 0) {
        notes.push(`${unusable} row(s) from your account were unusable and skipped`);
      }
      if (receiptsOmitted > 0) {
        notes.push(
          `${receiptsOmitted} receipt photo(s) were too large to sync and stayed on this device`,
        );
      }
      if (unsendable > 0) {
        // Named plainly: this one is not a transient network condition, it will
        // not fix itself, and the rows are only on this device until it is
        // dealt with.
        notes.push(
          `${unsendable} row(s) could not be uploaded and stay on this device only`,
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
      // Shared cars (#66). An ended share is said by name: a car vanishing
      // from the list without a word reads as data loss.
      for (const ended of all.shares.ended) {
        notes.push(`${ended.vehicleName || 'A car'} is no longer shared with you, so it was removed from this device`);
      }
      // #78: never synced, and said so — it does not go away on its own.
      for (const clash of all.shares.clashed) {
        notes.push(
          `${clash.vehicleName || 'A shared car'} from ${clash.ownerName || 'its owner'} names a car that is already yours, so it was not synced — leave it under Vehicles`,
        );
      }
      // #84: refused by the owner's account — the data, not the network, so
      // "will be retried" would be a promise that never comes true.
      for (const refused of all.shares.rejected) {
        notes.push(
          `changes to ${refused.vehicleName || 'a shared car'} were refused by ${refused.ownerName || 'its owner'}'s account and stay on this device only`,
        );
      }
      if (all.shares.failed.length > 0) {
        notes.push(`${all.shares.failed.length} shared car(s) could not be reached and will be retried`);
      }
      setMessage(notes.length === 0 ? null : `Synced. ${notes.join('; ')}.`);

      const changed =
        pulled.vehiclesWritten + pulled.fillUpsWritten + pulled.pendingWritten > 0;
      // A shared car's sync can bring rows too; reloading is cheap next to
      // showing someone a fill-up their partner logged a minute ago late.
      const sharesMoved = all.shares.synced.length + all.shares.ended.length > 0;
      if (changed || repaired > 0 || sharesMoved) await onChanged();
    } finally {
      setSyncing(false);
    }
  }, [store, remote, onChanged, state, setLastSyncedAt, sharing]);

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

  // One object per change, not per render (#88).
  return useMemo(
    () => ({ syncing, lastSyncedAt, message, refused, syncNow, afterWrite }),
    [syncing, lastSyncedAt, message, refused, syncNow, afterWrite],
  );
}
