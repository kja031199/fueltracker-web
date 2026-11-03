/**
 * The fuel log as the screens see it: what to show, and every way to change it
 * (#56).
 *
 * ## The one place a write happens
 *
 * Screens used to be handed the raw `FuelTrackerStore`, call it, and then call
 * an `onChanged` they had also been handed. "A write is followed by a refresh
 * and a sync" was therefore true at each call site where somebody remembered —
 * and a forgotten sync is invisible until another device is missing a fill-up.
 *
 * Here every write action is built by `written`: run the store call, refresh
 * what is shown, then schedule a sync (`useSync.afterWrite`, #52). A screen
 * cannot write any other way, because it cannot reach the store:
 * `src/test/storeBoundary.test.ts` fails if a component other than this file
 * and the composition root imports it. `FuelLog.test.tsx` checks the rule
 * once, for every action.
 *
 * A write that throws neither refreshes nor syncs — nothing changed — and the
 * error goes back to the screen that asked, which is the one that can say so.
 *
 * ## One source of truth
 *
 * Screens used to receive both the store and data derived from it as props.
 * Now they read both from here, so what a screen shows and what it writes to
 * are the same thing.
 */

import type { ReactElement, ReactNode } from 'react';
import { createContext, useCallback, useContext, useMemo } from 'react';
import type { FillUpRecord, Snapshot, VehicleRecord } from '../data/records';
import type { ImportSummary } from '../data/backup';
import type { RemoteStore } from '../data/remote';
import type { FuelTrackerStore, NewVehicle } from '../data/store';
import type { SyncStateStore } from '../data/syncState';
import type { FuelEntryDraft } from '../domain/fuelEntryDraft';
import type { AppData } from './useAppData';
import { useAppData } from './useAppData';
import type { BackupSummary } from './exportBackup';
import { saveJsonBackup } from './exportBackup';
import type { SyncStatus } from './useSync';
import { useSync } from './useSync';

export interface FuelLog extends Omit<AppData, 'reload'> {
  readonly sync: SyncStatus;

  // Writes: each refreshes what is shown and schedules a sync.
  addVehicle(vehicle: NewVehicle): Promise<VehicleRecord>;
  removeVehicle(id: string): Promise<void>;
  addFillUp(draft: FuelEntryDraft, vehicleId: string): Promise<FillUpRecord>;
  updateFillUp(id: string, draft: FuelEntryDraft, vehicleId: string): Promise<FillUpRecord>;
  removeFillUp(id: string): Promise<void>;
  importBackup(snapshot: Snapshot): Promise<ImportSummary>;

  // Reads.
  /**
   * One fill-up whole, photo included, for editing. The list holds summaries
   * without photo bytes (#53). `undefined` when it has gone since the list was
   * drawn — deleted on another device and synced — in which case the list is
   * refreshed, but nothing is synced, because nothing here changed.
   */
  loadFillUp(id: string): Promise<FillUpRecord | undefined>;
  /** Everything, tombstones included: what the CSV export filters. */
  exportSnapshot(): Promise<Snapshot>;
  /** Downloads a JSON backup and says what it held. */
  saveBackup(): Promise<BackupSummary>;
}

const FuelLogContext = createContext<FuelLog | null>(null);

export interface FuelLogProviderProps {
  readonly store: FuelTrackerStore;
  /** The account's copy, or null when nothing syncs (signed out, no config). */
  readonly remote: RemoteStore | null;
  readonly syncState?: SyncStateStore;
  /** Whose log this is, for the account-scoped last-sync time (#55). */
  readonly uid: string | null;
  readonly children: ReactNode;
}

export function FuelLogProvider({
  store,
  remote,
  syncState,
  uid,
  children,
}: FuelLogProviderProps): ReactElement {
  const data = useAppData(store);
  const sync = useSync(store, remote, data.reload, syncState, uid);
  const { reload } = data;
  const { afterWrite } = sync;

  /** The rule, once: write, then refresh, then sync. A throw skips both. */
  const written = useCallback(
    <A extends unknown[], R>(write: (...args: A) => Promise<R>) =>
      async (...args: A): Promise<R> => {
        const result = await write(...args);
        await reload();
        afterWrite();
        return result;
      },
    [reload, afterWrite],
  );

  const log = useMemo<FuelLog>(() => {
    const { reload: _reload, ...shown } = data;
    return {
      ...shown,
      sync,
      addVehicle: written((vehicle: NewVehicle) => store.addVehicle(vehicle)),
      removeVehicle: written((id: string) => store.removeVehicle(id)),
      addFillUp: written((draft: FuelEntryDraft, vehicleId: string) => store.addFillUp(draft, vehicleId)),
      updateFillUp: written((id: string, draft: FuelEntryDraft, vehicleId: string) =>
        store.updateFillUp(id, draft, vehicleId),
      ),
      removeFillUp: written((id: string) => store.removeFillUp(id)),
      importBackup: written((snapshot: Snapshot) => store.importBackup(snapshot)),
      loadFillUp: async (id: string) => {
        const whole = await store.fillUp(id);
        if (whole === undefined) await reload();
        return whole;
      },
      exportSnapshot: () => store.exportSnapshot(),
      saveBackup: () => saveJsonBackup(store),
    };
  }, [data, sync, written, store, reload]);

  return <FuelLogContext.Provider value={log}>{children}</FuelLogContext.Provider>;
}

/** The fuel log. Only inside `FuelLogProvider`, which `App` puts around every screen. */
export function useFuelLog(): FuelLog {
  const log = useContext(FuelLogContext);
  if (log === null) {
    throw new Error('useFuelLog() was called outside <FuelLogProvider>; App renders the screens inside one.');
  }
  return log;
}
