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
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { FillUpRecord, Snapshot, VehicleRecord } from '../data/records';
import type { ImportSummary } from '../data/backup';
import type { RemoteStore } from '../data/remote';
import type { FuelTrackerStore, NewVehicle } from '../data/store';
import type { SyncStateStore } from '../data/syncState';
import type { SharingSync } from '../data/shareSync';
import type { Invite, Member, Membership } from '../data/sharing';
import { ShareClash } from '../data/sharing';
import { StaleEdit } from '../data/staleEdit';
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
  /** Who a car is shared with — this account's own car, or one shared with it. Read fresh. */
  membersOf(vehicleId: string): Promise<Member[]>;
  /**
   * The names to show for who entered a car's fill-ups — `null` for a car
   * nobody shares, where "entered by you" on every row would be noise.
   * `entered` is the uids its fill-ups carry. Remembered per car (#89): read
   * once, and again only when a fill-up names somebody it has not seen.
   */
  namesFor(vehicleId: string, entered: readonly (string | null | undefined)[]): Promise<ReadonlyMap<string, string> | null>;
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
  namesFor: async () => null,
  removeMember: async () => {},
  accept: () => Promise.reject(new Error('Sharing needs an account.')),
  decline: async () => {},
  leave: async () => {},
};

/**
 * The fuel log. Sync status is **not** in here (#88): it changes several
 * times per sync, and every screen reads this — `useSyncStatus()` is its own
 * context, read by the few screens that show it.
 */
export interface FuelLog extends Omit<AppData, 'reload'> {
  readonly sharing: SharingView;
  /** The signed-in account's uid, for "entered by you". Null when there is none. */
  readonly me: string | null;

  // Writes: each refreshes what is shown and schedules a sync.
  addVehicle(vehicle: NewVehicle): Promise<VehicleRecord>;
  removeVehicle(id: string): Promise<void>;
  addFillUp(draft: FuelEntryDraft, vehicleId: string): Promise<FillUpRecord>;
  /**
   * Edits a fill-up on the car it is already on (#83). Rejects with
   * `StaleEdit` when it, or its car, has gone since the form opened — and then
   * refreshes, since what the screen shows is out of date.
   */
  updateFillUp(id: string, draft: FuelEntryDraft): Promise<FillUpRecord>;
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
const SyncStatusContext = createContext<SyncStatus | null>(null);

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
  // The sync reads which cars are shared with this account; the sharing view
  // is handed that list rather than reading it again (#89). A ref, because the
  // view is built after the sync.
  const sharesRead = useRef<(memberships: readonly Membership[]) => void>(() => {});
  const onShares = useCallback((memberships: readonly Membership[]) => sharesRead.current(memberships), []);
  const sync = useSync(store, remote, data.reload, syncState, uid, remote === null ? null : sharing, onShares);
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
    // Every input here is stable between changes (#88): `data` and
    // `sharingView` are memoised, and `written` depends only on `reload` and
    // `afterWrite`, which never change. Sync status is deliberately not one.
  }, [data, written, store, reload, sharingView, uid, shared]);

  return (
    <SyncStatusContext.Provider value={sync}>
      <FuelLogContext.Provider value={log}>{children}</FuelLogContext.Provider>
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
  /** Where the sync hands over the memberships it read (#89). */
  sharesRead: { current: (memberships: readonly Membership[]) => void },
): SharingView {
  const [sharedWithMe, setSharedWithMe] = useState<readonly Membership[]>([]);
  const [invitesForMe, setInvitesForMe] = useState<readonly Invite[]>([]);
  // Who each car is shared with, and every uid already asked about for it —
  // so a uid that is nobody's now (a member since removed) is asked once.
  const names = useRef(new Map<string, { members: readonly Member[]; asked: ReadonlySet<string> }>());

  // Each list is replaced only when it differs (#88): these run after every
  // sync, and a new array with the same entries re-rendered every screen.
  // Once a sync has said which cars are shared, its answer wins over the
  // ledger's: the ledger leaves out a share it would not record (#78), which
  // still has to be listed so it can be left.
  const synced = useRef(false);
  useEffect(() => {
    sharesRead.current = (memberships) => {
      synced.current = true;
      setSharedWithMe((shown) => unlessSame(shown, memberships));
    };
  }, [sharesRead]);

  /**
   * What only this view reads: the device's ledger, so a shared car is known
   * as one before the first sync, and the invitations waiting for this account. The
   * cars shared with it come from the sync, which has just read them (#89) —
   * this used to read them again after every sync.
   */
  const refresh = useCallback(async () => {
    if (sharing === null) return;
    if (!synced.current) {
      const held = await sharing.ledger.load().catch(() => null);
      if (held !== null && !synced.current) setSharedWithMe((shown) => unlessSame(shown, held));
    }
    const invites = await sharing.remote.invitesForMe().catch(() => null);
    if (invites !== null) setInvitesForMe((shown) => unlessSame(shown, invites));
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
      // That car's alone, not every invitation sent (#89).
      invitesSentFor: (vehicleId) => remote.invitesSent(vehicleId),
      membersOf: async (vehicleId) => {
        const members = await remote.members(membershipFor(vehicleId)?.ownerUid ?? uid, vehicleId);
        // A fresh read is the best answer the names can have, too.
        names.current.set(vehicleId, { members, asked: new Set(members.map((member) => member.uid)) });
        return members;
      },
      namesFor: async (vehicleId, entered) => {
        const membership = membershipFor(vehicleId);
        const owner = membership?.ownerUid ?? uid;
        const others = entered.filter(
          (who): who is string => typeof who === 'string' && who !== '' && who !== uid && who !== owner,
        );
        let known = names.current.get(vehicleId);
        if (known === undefined || others.some((who) => !known!.asked.has(who))) {
          const members = await remote.members(owner, vehicleId);
          known = { members, asked: new Set([...(known?.asked ?? []), ...others, ...members.map((m) => m.uid)]) };
          names.current.set(vehicleId, known);
        }
        if (membership === undefined && known.members.length === 0) return null; // not shared
        const shown = new Map<string, string>();
        for (const member of known.members) shown.set(member.uid, member.name || member.email);
        if (membership !== undefined) shown.set(membership.ownerUid, membership.ownerName || 'its owner');
        shown.set(uid, 'you');
        return shown;
      },
      // The panel re-reads the members after this (`membersOf`), which
      // refreshes the names too.
      removeMember: (vehicleId, memberUid) => remote.removeMember(vehicleId, memberUid),
      accept: async (invite) => {
        // Checked here, before anything is written, as well as by the rules
        // (which only see cars already in the account) and by sync (#78).
        if (await store.hasVehicle(invite.vehicleId)) throw new ShareClash();
        await remote.accept(invite);
        names.current.delete(invite.vehicleId);
        await refresh();
        await syncNow();
      },
      decline: async (invite) => {
        await remote.decline(invite);
        await refresh();
      },
      leave: async (membership) => {
        await remote.leave(membership);
        names.current.delete(membership.vehicleId);
        await syncNow();
        await refresh();
      },
    };
  }, [sharing, uid, sharedWithMe, invitesForMe, refresh, syncNow, store]);
}

/** `next`, unless it holds exactly what `shown` does — then `shown`, so nothing re-renders. */
function unlessSame<T>(shown: readonly T[], next: readonly T[]): readonly T[] {
  return JSON.stringify(shown) === JSON.stringify(next) ? shown : next;
}
