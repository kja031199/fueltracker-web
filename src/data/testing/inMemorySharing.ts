/**
 * Several accounts and the sharing between them, in memory, for tests (#66).
 *
 * So that sync, the store and the screens can be tested against sharing
 * without an emulator. It enforces the rules' checks in code — member or not,
 * `enteredBy` is yours, a fill-up cannot be moved to another car — and refuses
 * with the same `permission-denied` code Firestore uses, so the code under
 * test meets the same failures. `firebase/sharingRemote.ts` is the real one,
 * tested against the real rules on the emulator; where the two read
 * differently, this one follows it (`InMemoryScopedRemote.pull`).
 *
 * Moved out of `sharing.ts` in #96, where it was two thirds of a production
 * module that production never runs.
 */

import type { FillUpRecord, Snapshot, VehicleRecord } from '../records';
import type { PullCursor, PushSummary, RawSnapshot, RemoteStore } from '../remote';
import { MAX_ACCEPTED_AHEAD_MS } from '../syncClock';
import type { Account, Invite, Member, Membership } from '../sharingTypes';
import type { SharingRemote } from '../sharing';
import { Refused, inviteKey, membershipKey, normalizeEmail } from '../sharing';
import { InMemoryRemoteStore } from './inMemoryRemote';

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

  /**
   * As `FirestoreScopedRemote.pull` reads (#96): the car's document whole,
   * every time, and its fill-ups since the cursor's fill-up mark — so the car
   * carries no mark of its own, and the fill-up mark is this car's, never the
   * owner's whole account's. It used to filter the owner's incremental pull,
   * which returned the car only when it had changed: a deleted car was then
   * seen by tests in a way production never shows it.
   */
  async pull(since: PullCursor | null = null): Promise<RawSnapshot> {
    await this.check('read a car you are not in');
    return this.world.remoteFor(this.share.ownerUid).pullCar(this.share.vehicleId, since);
  }

  async push(snapshot: Snapshot): Promise<PushSummary> {
    await this.check('write to a car you are not in');
    if (snapshot.vehicles.length > 0 || snapshot.pendingFillUps.length > 0) {
      throw new Refused('a member writes fill-ups only');
    }
    const owner = this.world.remoteFor(this.share.ownerUid);
    const existing = new Map(((await owner.pull(null)).fillUps as FillUpRecord[]).map((row) => [row.id, row]));
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
