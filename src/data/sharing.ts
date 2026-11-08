/**
 * Sharing a car with another account (#66): the vocabulary, and an in-memory
 * world that obeys the same rules as `firestore.rules`.
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
 * ## Why an in-memory world
 *
 * So that sync, the store and the screens can be tested against sharing
 * without an emulator. It enforces the rules' checks in code — member or not,
 * `enteredBy` is yours, a fill-up cannot be moved to another car — and refuses
 * with the same `permission-denied` code Firestore uses, so the code under
 * test meets the same failures. `firebase/sharingRemote.ts` is the real one,
 * tested against the real rules on the emulator.
 */

import type { FillUpRecord, Snapshot, VehicleRecord } from './records';
import type { PullCursor, PushSummary, RawSnapshot, RemoteStore } from './remote';
import { InMemoryRemoteStore } from './remote';
import { MAX_ACCEPTED_AHEAD_MS } from './syncClock';

/** An open invitation to one car, addressed to one email. */
export interface Invite {
  readonly ownerUid: string;
  readonly vehicleId: string;
  /** Lowercased: the rules compare it to the token's address, lowercased. */
  readonly email: string;
  readonly ownerName: string;
  readonly vehicleName: string;
  readonly createdAt: number;
}

/** Somebody a car is shared with. */
export interface Member {
  readonly uid: string;
  readonly name: string;
  readonly email: string;
  readonly joinedAt: number;
}

/** A car shared *with* this account. */
export interface Membership {
  readonly ownerUid: string;
  readonly vehicleId: string;
  readonly ownerName: string;
  readonly vehicleName: string;
}

/** The signed-in account, as sharing needs it. */
export interface Account {
  readonly uid: string;
  readonly name: string;
  /** As Google reports it; compared lowercased. */
  readonly email: string;
  readonly emailVerified: boolean;
}

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

/** What Firestore throws when the rules say no, so `isRefusal` sees the same. */
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

export class Refused extends Error {
  readonly code = 'permission-denied';
  constructor(what: string) {
    super(`refused: ${what}`);
  }
}

// --- The in-memory world ------------------------------------------------------

/**
 * Several accounts' data, and the sharing documents between them. `remoteFor`
 * gives an account's own `RemoteStore`; `sharingFor` its `SharingRemote`.
 */
export class InMemorySharingWorld {
  private readonly trees = new Map<string, InMemoryRemoteStore>();
  readonly invites = new Map<string, Invite>();
  /** `{owner}__{vehicle}` → members by uid. */
  readonly members = new Map<string, Map<string, Member>>();
  /** member uid → memberships by key. */
  readonly memberships = new Map<string, Map<string, Membership>>();
  /**
   * How many times each sharing read has been made, by anyone (#89). On the
   * free plan reads are what runs out, so tests count them.
   */
  readonly reads = { memberships: 0, members: 0, invitesForMe: 0, invitesSent: 0 };

  /** An account's own tree — what its ordinary sync pushes to and pulls from. */
  remoteFor(uid: string): InMemoryRemoteStore {
    let tree = this.trees.get(uid);
    if (tree === undefined) {
      tree = new InMemoryRemoteStore();
      this.trees.set(uid, tree);
    }
    return tree;
  }

  sharingFor(account: Account): SharingRemote {
    return new InMemorySharing(this, account);
  }

  isMember(ownerUid: string, vehicleId: string, uid: string): boolean {
    return this.members.get(`${ownerUid}__${vehicleId}`)?.has(uid) ?? false;
  }

  /** As the rules' `memberOf` (#80): a member of a car that still exists. */
  async isLiveMember(ownerUid: string, vehicleId: string, uid: string): Promise<boolean> {
    return this.isMember(ownerUid, vehicleId, uid) && (await this.liveVehicle(ownerUid, vehicleId)) !== undefined;
  }

  /** The owner's live, non-deleted car, or undefined. */
  async liveVehicle(ownerUid: string, vehicleId: string): Promise<VehicleRecord | undefined> {
    const raw = await this.remoteFor(ownerUid).pull(null);
    const vehicle = (raw.vehicles as VehicleRecord[]).find((v) => v.id === vehicleId);
    return vehicle !== undefined && vehicle.deletedAt === null ? vehicle : undefined;
  }
}

class InMemorySharing implements SharingRemote {
  constructor(
    private readonly world: InMemorySharingWorld,
    private readonly me: Account,
  ) {}

  private myEmail(): string | null {
    return this.me.emailVerified ? this.me.email.toLowerCase() : null;
  }

  async invite(vehicle: Pick<VehicleRecord, 'id' | 'name'>, raw: string): Promise<Invite> {
    const email = normalizeEmail(raw);
    if (email === null) throw new Error('not an email address');
    if ((await this.world.liveVehicle(this.me.uid, vehicle.id)) === undefined) {
      throw new Refused('invite to a car you do not have');
    }
    const key = inviteKey(this.me.uid, vehicle.id, email);
    if (this.world.invites.has(key)) throw new Refused('an invitation is never rewritten');
    const invite: Invite = {
      ownerUid: this.me.uid,
      vehicleId: vehicle.id,
      email,
      ownerName: this.me.name,
      vehicleName: vehicle.name,
      createdAt: Date.now(),
    };
    this.world.invites.set(key, invite);
    return invite;
  }

  async withdrawInvite(vehicleId: string, email: string): Promise<void> {
    this.world.invites.delete(inviteKey(this.me.uid, vehicleId, email));
  }

  async invitesSent(vehicleId?: string): Promise<Invite[]> {
    this.world.reads.invitesSent += 1;
    return [...this.world.invites.values()].filter(
      (invite) => invite.ownerUid === this.me.uid && (vehicleId === undefined || invite.vehicleId === vehicleId),
    );
  }

  async members(ownerUid: string, vehicleId: string): Promise<Member[]> {
    this.world.reads.members += 1;
    if (ownerUid !== this.me.uid && !(await this.world.isLiveMember(ownerUid, vehicleId, this.me.uid))) {
      throw new Refused('members of a car you are not in');
    }
    return [...(this.world.members.get(`${ownerUid}__${vehicleId}`)?.values() ?? [])];
  }

  async removeMember(vehicleId: string, memberUid: string): Promise<void> {
    const room = this.world.members.get(`${this.me.uid}__${vehicleId}`);
    const email = room?.get(memberUid)?.email;
    room?.delete(memberUid);
    if (email !== undefined) this.world.invites.delete(inviteKey(this.me.uid, vehicleId, email));
  }

  async endSharing(vehicleId: string): Promise<void> {
    this.world.members.delete(`${this.me.uid}__${vehicleId}`);
    for (const [key, invite] of this.world.invites) {
      if (invite.ownerUid === this.me.uid && invite.vehicleId === vehicleId) this.world.invites.delete(key);
    }
  }

  async invitesForMe(): Promise<Invite[]> {
    this.world.reads.invitesForMe += 1;
    const email = this.myEmail();
    if (email === null) return [];
    return [...this.world.invites.values()].filter((invite) => invite.email === email);
  }

  async accept(invite: Invite): Promise<Membership> {
    const email = this.myEmail();
    const key = inviteKey(invite.ownerUid, invite.vehicleId, invite.email);
    if (email === null || email !== invite.email || !this.world.invites.has(key)) {
      throw new Refused('join without an invitation');
    }
    if (invite.ownerUid === this.me.uid) throw new Refused('join your own car');
    // As firestore.rules: only a car that still exists (#80).
    if ((await this.world.liveVehicle(invite.ownerUid, invite.vehicleId)) === undefined) {
      throw new Refused('join a car that has been deleted');
    }
    // As firestore.rules: never a car whose id names one of your own (#78).
    if (this.world.remoteFor(this.me.uid).hasVehicle(invite.vehicleId)) {
      throw new Refused('join a car with the id of one of your own');
    }
    const room = `${invite.ownerUid}__${invite.vehicleId}`;
    const members = this.world.members.get(room) ?? new Map<string, Member>();
    members.set(this.me.uid, { uid: this.me.uid, name: this.me.name, email, joinedAt: Date.now() });
    this.world.members.set(room, members);
    const membership: Membership = {
      ownerUid: invite.ownerUid,
      vehicleId: invite.vehicleId,
      ownerName: invite.ownerName,
      vehicleName: invite.vehicleName,
    };
    const mine = this.world.memberships.get(this.me.uid) ?? new Map<string, Membership>();
    mine.set(membershipKey(membership), membership);
    this.world.memberships.set(this.me.uid, mine);
    this.world.invites.delete(key);
    return membership;
  }

  async decline(invite: Invite): Promise<void> {
    if (this.myEmail() !== invite.email) throw new Refused('decline someone else’s invitation');
    this.world.invites.delete(inviteKey(invite.ownerUid, invite.vehicleId, invite.email));
  }

  async memberships(): Promise<Membership[]> {
    this.world.reads.memberships += 1;
    return [...(this.world.memberships.get(this.me.uid)?.values() ?? [])];
  }

  async leave(membership: Membership): Promise<void> {
    this.world.members.get(`${membership.ownerUid}__${membership.vehicleId}`)?.delete(this.me.uid);
    this.world.memberships.get(this.me.uid)?.delete(membershipKey(membership));
  }

  scoped(membership: Membership): RemoteStore {
    return new InMemoryScopedRemote(this.world, membership, this.me.uid);
  }
}

/**
 * The owner's account, narrowed to one car — what a member's sync of that car
 * talks to. Refuses everything once the member is no longer one, exactly as
 * the rules do.
 */
class InMemoryScopedRemote implements RemoteStore {
  constructor(
    private readonly world: InMemorySharingWorld,
    private readonly share: Membership,
    private readonly uid: string,
  ) {}

  private async check(what: string): Promise<void> {
    if (!(await this.world.isLiveMember(this.share.ownerUid, this.share.vehicleId, this.uid))) throw new Refused(what);
  }

  async pull(since: PullCursor | null = null): Promise<RawSnapshot> {
    await this.check('read a car you are not in');
    const raw = await this.world.remoteFor(this.share.ownerUid).pull(since);
    return scopeSnapshot(raw, this.share.vehicleId);
  }

  async push(snapshot: Snapshot): Promise<PushSummary> {
    await this.check('write to a car you are not in');
    if (snapshot.vehicles.length > 0 || snapshot.pendingFillUps.length > 0) {
      throw new Refused('a member writes fill-ups only');
    }
    const owner = this.world.remoteFor(this.share.ownerUid);
    const existing = new Map(
      ((await owner.pull(null)).fillUps as FillUpRecord[]).map((row) => [row.id, row]),
    );
    for (const row of snapshot.fillUps) {
      const before = existing.get(row.id);
      if (row.vehicleId !== this.share.vehicleId) throw new Refused('a fill-up for another car');
      if (before === undefined && row.enteredBy !== this.uid) throw new Refused('entered by someone else');
      if (before !== undefined && before.vehicleId !== this.share.vehicleId) throw new Refused('another car’s fill-up');
      if (before !== undefined && (row.enteredBy ?? null) !== (before.enteredBy ?? null)) {
        throw new Refused('changing who entered a fill-up');
      }
      // As firestore.rules (#79): no stamp further ahead than an honest
      // device can be, and none taking a document backwards.
      if (!Number.isFinite(row.updatedAt) || row.updatedAt > Date.now() + MAX_ACCEPTED_AHEAD_MS) {
        throw new Refused('a stamp too far ahead');
      }
      if (before !== undefined && row.updatedAt < before.updatedAt) throw new Refused('a stamp taken backwards');
    }
    return owner.push(snapshot);
  }
}

/** One car's rows out of a whole account's pull, keeping the cursor honest. */
export function scopeSnapshot(raw: RawSnapshot, vehicleId: string): RawSnapshot {
  const ofCar = (row: unknown): boolean =>
    typeof row === 'object' && row !== null && (row as { vehicleId?: unknown }).vehicleId === vehicleId;
  const isCar = (row: unknown): boolean =>
    typeof row === 'object' && row !== null && (row as { id?: unknown }).id === vehicleId;
  return {
    vehicles: raw.vehicles.filter(isCar),
    fillUps: raw.fillUps.filter(ofCar),
    pendingFillUps: [],
    // Every row stamped after the old mark came back in this pull — the
    // car's included — so the account-wide high-water mark skips nothing.
    ...(raw.highWater === undefined
      ? {}
      : { highWater: { ...raw.highWater, pendingFillUps: null } }),
  };
}
