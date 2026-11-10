/**
 * Sharing a car (#66), as the fuel log hands it to the screens: the lists of
 * cars shared with this account and invitations waiting for it, kept fresh,
 * and the actions on them. Moved out of `fuelLog.tsx` (#93); only the fuel
 * log calls it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FuelTrackerStore } from '../data/store';
import type { SharingSync } from '../data/shareSync';
import type { Invite, Member, Membership } from '../data/sharing';
import { ShareClash } from '../data/sharing';
import { verifiedName } from './wording';
import type { SharingView } from './fuelLogTypes';

/** What a fuel log with no account to share through offers: nothing, and every action refuses. */
export const SHARING_OFF: SharingView = {
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
 * The sharing lists, kept fresh: read on mount and after every sync, from the
 * device's ledger first so a shared car is recognised as one even offline.
 * A failed read keeps the last good lists rather than emptying them.
 */
export function useSharingView(
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
        // Members by their verified email (#81): a chosen name alone let a
        // member pass as the owner. The owner is marked by being the owner —
        // their uid is the membership's — which no member's name can fake.
        for (const member of known.members) shown.set(member.uid, verifiedName(member));
        if (membership !== undefined) {
          const ownerName = membership.ownerName.trim();
          shown.set(membership.ownerUid, ownerName === '' ? 'the owner' : `${ownerName} (owner)`);
        }
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
