/**
 * Running a sync, and remembering when the last one worked.
 *
 * ## When it runs, and why not more often
 *
 * On mount (so signing in pulls the account down), on window focus (so coming
 * back to a tab that was open on another device catches up), and on demand from
 * Settings. That is all.
 *
 * No realtime listener, and no sync on every keystroke or write. The free tier
 * allows 20,000 writes and 50,000 reads a day, which is enormous for one
 * person's fuel log right up until something syncs in a loop — and an app that
 * silently stops working at 4pm because it burned its quota is a worse failure
 * than one that is a few seconds stale. A fuel log changes a few times a month.
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
  readonly syncNow: () => Promise<void>;
}

export function useSync(
  store: FuelTrackerStore,
  remote: RemoteStore | null,
  /** Called after a sync that changed anything, so the screens reload. */
  onChanged: () => Promise<void>,
): SyncStatus {
  const [syncing, setSyncing] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(() => loadLastSynced());
  const [message, setMessage] = useState<string | null>(null);
  // Guards against two syncs overlapping — a focus event landing while the
  // mount sync is still in flight would otherwise push the same rows twice.
  const running = useRef(false);

  const syncNow = useCallback(async () => {
    if (remote === null || running.current) return;
    running.current = true;
    setSyncing(true);
    try {
      const result = await syncOnce(store, remote);
      if (!result.ok) {
        setMessage(result.reason);
        return;
      }
      const { pulled, pushed, skippedNewerSchema, invalid, unbeatable, at } = result.outcome;
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
      if (changed) await onChanged();
    } finally {
      running.current = false;
      setSyncing(false);
    }
  }, [store, remote, onChanged]);

  useEffect(() => {
    void syncNow();
  }, [syncNow]);

  useEffect(() => {
    function onFocus(): void {
      void syncNow();
    }
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [syncNow]);

  return { syncing, lastSyncedAt, message, syncNow };
}
