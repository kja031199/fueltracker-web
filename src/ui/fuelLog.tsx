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
 *
 * @trap #93 — The fuel log records a backup, never a screen: `saveBackup()`
 * downloads and records it in one step, and a new way to ask for a backup calls
 * it and adds nothing. `exportCsv()` records nothing. Screens read the reminder
 * through `useBackupStatus()`, so recording one leaves `useFuelLog()`
 * unchanged.
 */

import type { ReactElement, ReactNode } from 'react';
import { createContext, useCallback, useContext, useMemo, useRef } from 'react';
import type { Snapshot } from '../data/records';
import type { RemoteStore } from '../data/remote';
import type { FuelTrackerStore, NewVehicle } from '../data/store';
import type { SyncStateStore } from '../data/syncState';
import type { SharingSync } from '../data/shareSync';
import type { Membership } from '../data/sharing';
import { StaleEdit } from '../data/staleEdit';
import type { FuelEntryDraft } from '../domain/fuelEntryDraft';
import type { Submission } from '../data/fillUpLink';
import { useAppData } from './useAppData';
import { saveCsvExport, saveJsonBackup } from './exportBackup';
import { parseBackupFile } from '../data/backupFormat';
import { useBackupNudge } from './backupNudge';
import type { SyncStatus } from './useSync';
import { useSync } from './useSync';
import type { SchedulerTimers } from './syncScheduler';
import { useSharingView } from './useSharingView';
import type { BackupStatus, FileImport, FuelLog, ReceiveResult } from './fuelLogTypes';

export type { BackupStatus, FileImport, FuelLog, ReceiveResult, SharingView } from './fuelLogTypes';

const FuelLogContext = createContext<FuelLog | null>(null);
const SyncStatusContext = createContext<SyncStatus | null>(null);
const BackupStatusContext = createContext<BackupStatus | null>(null);

export interface FuelLogProviderProps {
  readonly store: FuelTrackerStore;
  /** The account's copy, or null when nothing syncs (signed out, no config). */
  readonly remote: RemoteStore | null;
  readonly syncState?: SyncStateStore;
  /** Whose log this is, for the account-scoped last-sync time (#55). */
  readonly uid: string | null;
  /** Cars shared with and by this account (#66). Omitted where nothing syncs. */
  readonly sharing?: SharingSync | null;
  /** Test seam (#97): the sync scheduler's timers, so a test fires the save-sync itself. */
  readonly syncTimers?: SchedulerTimers;
  readonly children: ReactNode;
}

export function FuelLogProvider({
  store,
  remote,
  syncState,
  uid,
  sharing = null,
  syncTimers,
  children,
}: FuelLogProviderProps): ReactElement {
  const data = useAppData(store);
  // The sync reads which cars are shared with this account; the sharing view
  // is handed that list rather than reading it again (#89). A ref, because the
  // view is built after the sync.
  const sharesRead = useRef<(memberships: readonly Membership[]) => void>(() => {});
  const onShares = useCallback((memberships: readonly Membership[]) => sharesRead.current(memberships), []);
  const sync = useSync(
    store,
    remote,
    data.reload,
    syncState,
    uid,
    remote === null ? null : sharing,
    onShares,
    syncTimers,
  );
  const sharingView = useSharingView(
    remote === null ? null : sharing,
    uid,
    sync.syncNow,
    sync.lastSyncedAt,
    store,
    sharesRead,
  );
  const { reload } = data;
  const { afterWrite } = sync;
  const nudge = useBackupNudge(data.fillUpCount, uid);
  const { recordBackup, snooze } = nudge;
  const lastBackupAt = nudge.state.lastExportAt;
  const backup = useMemo<BackupStatus>(
    () => ({ reason: nudge.reason, lastBackupAt, snooze }),
    [nudge.reason, lastBackupAt, snooze],
  );
  const shared = remote === null ? null : sharing;

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
    const receive = written((submission: Submission) => store.receiveSubmission(submission));
    const update = written((id: string, draft: FuelEntryDraft) => store.updateFillUp(id, draft));
    const importBackup = written((snapshot: Snapshot) => store.importBackup(snapshot));
    // The device's ledger is read as well as the lists in state, which are
    // filled asynchronously: a link opened as the app starts is checked
    // against what this device knows, not against lists still loading.
    const heldByMembership = async (vehicleId: string): Promise<boolean> => {
      if (sharingView.membershipFor(vehicleId) !== undefined) return true;
      if (shared === null) return false;
      const held = await shared.ledger.load().catch(() => null);
      return held?.some((membership) => membership.vehicleId === vehicleId) ?? false;
    };
    return {
      ...shown,
      sharing: sharingView,
      me: uid,
      addVehicle: written((vehicle: NewVehicle) => store.addVehicle(vehicle)),
      removeVehicle: written(async (id: string) => {
        await store.removeVehicle(id);
        // One of yours, shared: its members and invitations go too (#80). The
        // rules already refuse a deleted car to everyone else; this clears
        // what would otherwise still list them. Best effort — offline, or
        // refused, it changes nothing a reader would lose.
        if (shared !== null && sharingView.membershipFor(id) === undefined) {
          await shared.remote.endSharing(id).catch(() => {});
        }
      }),
      addFillUp: written((draft: FuelEntryDraft, vehicleId: string) => store.addFillUp(draft, vehicleId)),
      updateFillUp: async (id: string, draft: FuelEntryDraft) => {
        try {
          return await update(id, draft);
        } catch (cause) {
          if (cause instanceof StaleEdit) await reload();
          throw cause;
        }
      },
      removeFillUp: written((id: string) => store.removeFillUp(id)),
      importBackup,
      receiveSubmission: async (submission: Submission): Promise<ReceiveResult> =>
        (await heldByMembership(submission.vehicleId)) ? 'not-yours' : receive(submission),
      approveSubmission: written((id: string) => store.approvePendingFillUp(id)),
      rejectSubmission: written((id: string) => store.rejectPendingFillUp(id)),
      loadFillUp: async (id: string) => {
        const whole = await store.fillUp(id);
        if (whole === undefined) await reload();
        return whole;
      },
      saveBackup: async () => {
        const saved = await saveJsonBackup(store);
        recordBackup(saved.fillUps);
        return saved;
      },
      exportCsv: () => saveCsvExport(store),
      importFile: async (file: File): Promise<FileImport> => {
        const parsed = parseBackupFile(file.name, await file.text());
        if (parsed.value === null) return { summary: null, problems: [parsed.error ?? 'That file could not be read.'] };
        const summary = await importBackup(parsed.value);
        return { summary, problems: [...parsed.skipped, ...summary.rejected] };
      },
    };
    // Every input here is stable between changes (#88): `data` and
    // `sharingView` are memoised, `written` depends only on `reload` and
    // `afterWrite`, which never change, and `recordBackup` only on the
    // account. Sync and backup status are deliberately not inputs.
  }, [data, written, store, reload, sharingView, uid, shared, recordBackup]);

  return (
    <SyncStatusContext.Provider value={sync}>
      <BackupStatusContext.Provider value={backup}>
        <FuelLogContext.Provider value={log}>{children}</FuelLogContext.Provider>
      </BackupStatusContext.Provider>
    </SyncStatusContext.Provider>
  );
}

/** The fuel log. Only inside `FuelLogProvider`, which `App` puts around every screen. */
export function useFuelLog(): FuelLog {
  const log = useContext(FuelLogContext);
  if (log === null) {
    throw new Error('useFuelLog() was called outside <FuelLogProvider>; App renders the screens inside one.');
  }
  return log;
}

/** The backup reminder. Only inside `FuelLogProvider`. */
export function useBackupStatus(): BackupStatus {
  const status = useContext(BackupStatusContext);
  if (status === null) {
    throw new Error('useBackupStatus() was called outside <FuelLogProvider>; App renders the screens inside one.');
  }
  return status;
}

/**
 * Whether a sync is running, when one last worked, and what it said — and the
 * way to start one. Its own context (#88), so a sync re-renders only the
 * screens that show it.
 */
export function useSyncStatus(): SyncStatus {
  const status = useContext(SyncStatusContext);
  if (status === null) {
    throw new Error('useSyncStatus() was called outside <FuelLogProvider>; App renders the screens inside one.');
  }
  return status;
}
