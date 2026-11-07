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
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { FillUpRecord, Snapshot, VehicleRecord } from '../data/records';
import type { ImportSummary } from '../data/backup';
import type { RemoteStore } from '../data/remote';
import type { FuelTrackerStore, NewVehicle } from '../data/store';
import type { SyncStateStore } from '../data/syncState';
import type { SharingSync } from '../data/shareSync';
import type { Invite, Member, Membership } from '../data/sharing';
import { ShareClash } from '../data/sharing';
import type { FuelEntryDraft } from '../domain/fuelEntryDraft';
import type { Submission } from '../data/fillUpLink';
import type { AppData } from './useAppData';
import { useAppData } from './useAppData';
import type { BackupSummary } from './exportBackup';
import { saveJsonBackup } from './exportBackup';
import type { SyncStatus } from './useSync';
import { useSync } from './useSync';

/**
 * Sharing a car (#66), as the screens see it. `enabled` is false without an
 * account to share through (no backend, or signed out), and then every list is
 * empty and every action refuses.
 */
export interface SharingView {
  readonly enabled: boolean;
  /** Cars shared *with* this account. */
  readonly sharedWithMe: readonly Membership[];
  /** Invitations waiting for this account's verified email. */
  readonly invitesForMe: readonly Invite[];
  /** The membership a car is held by, or undefined when it is this account's own. */
  membershipFor(vehicleId: string): Membership | undefined;
  /** Invites `email` to one of this account's cars. */
  invite(vehicle: Pick<VehicleRecord, 'id' | 'name'>, email: string): Promise<void>;
  withdrawInvite(vehicleId: string, email: string): Promise<void>;
  /** Unanswered invitations this account sent for one car. */
  invitesSentFor(vehicleId: string): Promise<Invite[]>;
  /** Who a car is shared with — this account's own car, or one shared with it. */
  membersOf(vehicleId: string): Promise<Member[]>;
  removeMember(vehicleId: string, memberUid: string): Promise<void>;
  /** Joins, then syncs so the car arrives at once. */
  accept(invite: Invite): Promise<void>;
  decline(invite: Invite): Promise<void>;
  /** Leaves, then syncs, which forgets the car on this device. */
  leave(membership: Membership): Promise<void>;
}

const SHARING_OFF: SharingView = {
  enabled: false,
  sharedWithMe: [],
  invitesForMe: [],
  membershipFor: () => undefined,
  invite: () => Promise.reject(new Error('Sharing needs an account.')),
  withdrawInvite: async () => {},
  invitesSentFor: async () => [],
  membersOf: async () => [],
  removeMember: async () => {},
  accept: () => Promise.reject(new Error('Sharing needs an account.')),
  decline: async () => {},
  leave: async () => {},
};

export interface FuelLog extends Omit<AppData, 'reload'> {
  readonly sync: SyncStatus;
  readonly sharing: SharingView;
  /** The signed-in account's uid, for "entered by you". Null when there is none. */
  readonly me: string | null;

  // Writes: each refreshes what is shown and schedules a sync.
  addVehicle(vehicle: NewVehicle): Promise<VehicleRecord>;
  removeVehicle(id: string): Promise<void>;
  addFillUp(draft: FuelEntryDraft, vehicleId: string): Promise<FillUpRecord>;
  updateFillUp(id: string, draft: FuelEntryDraft, vehicleId: string): Promise<FillUpRecord>;
  removeFillUp(id: string): Promise<void>;
  importBackup(snapshot: Snapshot): Promise<ImportSummary>;
  /**
   * Queues a fill-up that arrived by link (#3) for review. Refused as
   * `'not-yours'` for a car shared *with* this account: requests are made
   * from a car's owner, so a submission for somebody else's car was not sent
   * here to be received.
   */
  receiveSubmission(submission: Submission): Promise<ReceiveResult>;
  /** The fill-up it became, or null when it could not be (its car is gone, it no longer validates). */
  approveSubmission(id: string): Promise<FillUpRecord | null>;
  rejectSubmission(id: string): Promise<void>;

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

export type ReceiveResult = 'queued' | 'duplicate' | 'no-such-car' | 'not-yours';

const FuelLogContext = createContext<FuelLog | null>(null);

export interface FuelLogProviderProps {
  readonly store: FuelTrackerStore;
  /** The account's copy, or null when nothing syncs (signed out, no config). */
  readonly remote: RemoteStore | null;
  readonly syncState?: SyncStateStore;
  /** Whose log this is, for the account-scoped last-sync time (#55). */
  readonly uid: string | null;
  /** Cars shared with and by this account (#66). Omitted where nothing syncs. */
  readonly sharing?: SharingSync | null;
  readonly children: ReactNode;
}

export function FuelLogProvider({
  store,
  remote,
  syncState,
  uid,
  sharing = null,
  children,
}: FuelLogProviderProps): ReactElement {
  const data = useAppData(store);
  const sync = useSync(store, remote, data.reload, syncState, uid, remote === null ? null : sharing);
  const sharingView = useSharingView(remote === null ? null : sharing, uid, sync.syncNow, sync.lastSyncedAt, store);
  const { reload } = data;
  const { afterWrite } = sync;
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
      sync,
      sharing: sharingView,
      me: uid,
      addVehicle: written((vehicle: NewVehicle) => store.addVehicle(vehicle)),
      removeVehicle: written((id: string) => store.removeVehicle(id)),
      addFillUp: written((draft: FuelEntryDraft, vehicleId: string) => store.addFillUp(draft, vehicleId)),
      updateFillUp: written((id: string, draft: FuelEntryDraft, vehicleId: string) =>
        store.updateFillUp(id, draft, vehicleId),
      ),
      removeFillUp: written((id: string) => store.removeFillUp(id)),
      importBackup: written((snapshot: Snapshot) => store.importBackup(snapshot)),
      receiveSubmission: async (submission: Submission): Promise<ReceiveResult> =>
        (await heldByMembership(submission.vehicleId)) ? 'not-yours' : receive(submission),
      approveSubmission: written((id: string) => store.approvePendingFillUp(id)),
      rejectSubmission: written((id: string) => store.rejectPendingFillUp(id)),
      loadFillUp: async (id: string) => {
        const whole = await store.fillUp(id);
        if (whole === undefined) await reload();
        return whole;
      },
      exportSnapshot: () => store.exportSnapshot(),
      saveBackup: () => saveJsonBackup(store),
    };
  }, [data, sync, written, store, reload, sharingView, uid, shared]);

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

/**
 * The sharing lists, kept fresh: read on mount and after every sync, from the
 * device's ledger first so a shared car is recognised as one even offline.
 * A failed read keeps the last good lists rather than emptying them.
 */
function useSharingView(
  sharing: SharingSync | null,
  uid: string | null,
  syncNow: () => Promise<void>,
  lastSyncedAt: number | null,
  store: FuelTrackerStore,
): SharingView {
  const [sharedWithMe, setSharedWithMe] = useState<readonly Membership[]>([]);
  const [invitesForMe, setInvitesForMe] = useState<readonly Invite[]>([]);

  const refresh = useCallback(async () => {
    if (sharing === null) return;
    const held = await sharing.ledger.load().catch(() => null);
    if (held !== null) setSharedWithMe(held);
    const [current, invites] = await Promise.all([
      sharing.remote.memberships().catch(() => null),
      sharing.remote.invitesForMe().catch(() => null),
    ]);
    if (current !== null) setSharedWithMe(current);
    if (invites !== null) setInvitesForMe(invites);
  }, [sharing]);

  useEffect(() => {
    void refresh();
  }, [refresh, lastSyncedAt]);

  return useMemo<SharingView>(() => {
    if (sharing === null || uid === null) return SHARING_OFF;
    const { remote } = sharing;
    const membershipFor = (vehicleId: string): Membership | undefined =>
      sharedWithMe.find((membership) => membership.vehicleId === vehicleId);
    return {
      enabled: true,
      sharedWithMe,
      invitesForMe,
      membershipFor,
      invite: async (vehicle, email) => {
        await remote.invite(vehicle, email);
      },
      withdrawInvite: (vehicleId, email) => remote.withdrawInvite(vehicleId, email),
      invitesSentFor: async (vehicleId) =>
        (await remote.invitesSent()).filter((invite) => invite.vehicleId === vehicleId),
      membersOf: (vehicleId) => remote.members(membershipFor(vehicleId)?.ownerUid ?? uid, vehicleId),
      removeMember: (vehicleId, memberUid) => remote.removeMember(vehicleId, memberUid),
      accept: async (invite) => {
        // Checked here, before anything is written, as well as by the rules
        // (which only see cars already in the account) and by sync (#78).
        if (await store.hasVehicle(invite.vehicleId)) throw new ShareClash();
        await remote.accept(invite);
        await refresh();
        await syncNow();
      },
      decline: async (invite) => {
        await remote.decline(invite);
        await refresh();
      },
      leave: async (membership) => {
        await remote.leave(membership);
        await syncNow();
        await refresh();
      },
    };
  }, [sharing, uid, sharedWithMe, invitesForMe, refresh, syncNow, store]);
}
