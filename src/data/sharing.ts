/**
 * Sharing a car with another account (#66): the vocabulary.
 *
 * ## The shape, in one paragraph
 *
 * A shared car **stays in its owner's account**. The owner invites an email
 * address; the person with that verified Google address accepts, which adds
 * them under the car's `members` and writes a `memberships` entry in their own
 * account so their other devices can find it. From then on the member reads
 * the car and reads and writes **its** fill-ups in the owner's account —
 * nothing else of the owner's. The owner's own sync needs no change at all: a
 * member's fill-ups simply appear in the owner's tree.
 *
 * `firebase/sharingRemote.ts` is the implementation; the tests use the
 * in-memory world in `testing/inMemorySharing.ts`, which obeys the same rules.
 */

import type { VehicleRecord } from './records';
import type { RemoteStore } from './remote';

// The shapes themselves live in `sharingTypes.ts` (#91), so the storage
// modules can name a membership without importing this one.
export type { Account, Invite, Member, Membership } from './sharingTypes';
import type { Invite, Member, Membership } from './sharingTypes';

export interface SharingRemote {
  // The owner's side.
  /** Invites `email` to `vehicle`. The address is normalised first. */
  invite(vehicle: Pick<VehicleRecord, 'id' | 'name'>, email: string): Promise<Invite>;
  withdrawInvite(vehicleId: string, email: string): Promise<void>;
  /**
   * Invitations this account has sent and nobody has answered — for one car
   * when `vehicleId` is given, which the account then reads alone (#89).
   */
  invitesSent(vehicleId?: string): Promise<Invite[]>;
  /** Who a car is shared with. Readable by its owner and its members. */
  members(ownerUid: string, vehicleId: string): Promise<Member[]>;
  /** Removes a member, and withdraws any invitation of theirs still there (#80). */
  removeMember(vehicleId: string, memberUid: string): Promise<void>;
  /**
   * Removes every member of one of this account's cars and withdraws every
   * invitation to it (#80): what deleting the car means for sharing. The
   * rules already refuse a deleted car to its members; this clears what is
   * left over, so nobody is still listed, or invited, to a car that is gone.
   */
  endSharing(vehicleId: string): Promise<void>;

  // The invitee's side.
  /** Invitations addressed to this account's verified email. */
  invitesForMe(): Promise<Invite[]>;
  /** Joins, records the membership, and uses up the invitation — atomically (#80). */
  accept(invite: Invite): Promise<Membership>;
  decline(invite: Invite): Promise<void>;
  /** Cars shared with this account, from its own `memberships`. */
  memberships(): Promise<Membership[]>;
  /** Stops being a member, and forgets the membership. */
  leave(membership: Membership): Promise<void>;
  /** The owner's account, narrowed to one shared car, for sync. */
  scoped(membership: Membership): RemoteStore;
}

/** The longest address the rules accept. RFC 5321 caps a path at 320. */
export const MAX_EMAIL_LENGTH = 320;

/**
 * An address as the rules will compare it, or `null` when it cannot be one.
 * Deliberately loose — one `@` with something either side — because the real
 * check is Google's: only a verified sign-in with exactly this address can
 * accept. This only stops typing mistakes from becoming invitations.
 */
export function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (email.length < 3 || email.length > MAX_EMAIL_LENGTH) return null;
  if (/\s/.test(email) || email.includes('/')) return null;
  const at = email.indexOf('@');
  if (at <= 0 || at !== email.lastIndexOf('@') || at === email.length - 1) return null;
  return email;
}

/** `{ownerUid}__{vehicleId}__{email}` — the rules find an invitation by this. */
export function inviteKey(ownerUid: string, vehicleId: string, email: string): string {
  return `${ownerUid}__${vehicleId}__${email}`;
}

/** `{ownerUid}__{vehicleId}` — one membership per shared car. */
export function membershipKey(membership: Pick<Membership, 'ownerUid' | 'vehicleId'>): string {
  return `${membership.ownerUid}__${membership.vehicleId}`;
}

/**
 * An invitation to a car whose id is already one of this account's cars
 * (#78). Accepting would hand that car to the inviter, so it is refused
 * before anything is written.
 */
export class ShareClash extends Error {
  constructor() {
    super('That invitation names a car that is already one of yours.');
  }
}

/** What Firestore throws when the rules say no, so `isRefusal` sees the same. */
export class Refused extends Error {
  readonly code = 'permission-denied';
  constructor(what: string) {
    super(`refused: ${what}`);
  }
}
