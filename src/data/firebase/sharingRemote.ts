/**
 * Sharing a car, against Firestore (#66). The in-memory version, which the
 * rest of the suite uses, is in `../sharing.ts`; this one is exercised against
 * the real `firestore.rules` on the emulator in `sharing.emulator.test.ts`.
 *
 * Every write here is one the rules check on their own — this class is a
 * convenience, not the boundary. A forged invitation, a join without one, a
 * fill-up moved to a private car: each is refused by `firestore.rules`
 * whatever any client sends.
 *
 * @trap #89 — CI does not deploy the shared-car index — the deploy account
 * lacks the role, deliberately; `firestore.indexes.json` is deployed once by
 * hand (docs/deploying.md). Until then `withIndexFallback` reads the whole car
 * and says so (`indexMissing`).
 */

import {
  collection,
  deleteDoc,
  doc,
  getDocFromServer,
  getDocsFromServer,
  query,
  setDoc,
  where,
  writeBatch,
  type DocumentData,
  type Firestore,
  type Query,
} from 'firebase/firestore';
import type { Snapshot } from '../records';
import type { PullCursor, PushSummary, RawSnapshot, RemoteStore } from '../remote';
import { getFirestore } from 'firebase/firestore';
import type { Account, Invite, Member, Membership, SharingRemote } from '../sharing';
import { Refused, inviteKey, membershipKey, normalizeEmail } from '../sharing';
import { parseLedger } from '../shareLedger';
import { TEXT_LIMITS, boundText } from '../../domain/textLimits';
import { decode, encodeReceipt, fromMicros, readStamped, writeStamped } from './remoteStore';
import { firebaseApp, type FirebaseSettings } from './config';
import { numberOr, textOr } from '../guards';

function asInvite(data: DocumentData): Invite | null {
  const ownerUid = textOr(data['ownerUid']);
  const vehicleId = textOr(data['vehicleId']);
  const email = textOr(data['email']);
  if (ownerUid === '' || vehicleId === '' || email === '') return null;
  return {
    ownerUid,
    vehicleId,
    email,
    // Read from the network, so bounded like every other text that is (#86).
    ownerName: textOr(data['ownerName'], TEXT_LIMITS.ownerName),
    vehicleName: textOr(data['vehicleName'], TEXT_LIMITS.vehicleName),
    createdAt: numberOr(data['createdAt'], 0),
  };
}

function asMember(data: DocumentData): Member | null {
  const uid = textOr(data['uid']);
  if (uid === '') return null;
  return {
    uid,
    name: textOr(data['name'], TEXT_LIMITS.name),
    email: textOr(data['email']),
    joinedAt: numberOr(data['joinedAt'], 0),
  };
}

export class FirestoreSharingRemote implements SharingRemote {
  constructor(
    private readonly db: Firestore,
    private readonly me: Account,
  ) {}

  /** Over the app's Firestore, for the signed-in account. */
  static forAccount(settings: FirebaseSettings, me: Account): FirestoreSharingRemote {
    return new FirestoreSharingRemote(getFirestore(firebaseApp(settings)), me);
  }

  private verifiedEmail(): string | null {
    return this.me.emailVerified ? this.me.email.toLowerCase() : null;
  }

  async invite(vehicle: { readonly id: string; readonly name: string }, raw: string): Promise<Invite> {
    const email = normalizeEmail(raw);
    if (email === null) throw new Error('That is not an email address.');
    const invite: Invite = {
      ownerUid: this.me.uid,
      vehicleId: vehicle.id,
      email,
      // Cut to what the rules accept (#86). A Google display name has no
      // limit of its own, and one over 200 characters used to fail the
      // invitation with nothing to say why.
      ownerName: boundText(this.me.name, TEXT_LIMITS.ownerName),
      vehicleName: boundText(vehicle.name, TEXT_LIMITS.vehicleName),
      createdAt: Date.now(),
    };
    await setDoc(doc(this.db, 'invites', inviteKey(this.me.uid, vehicle.id, email)), { ...invite });
    return invite;
  }

  async withdrawInvite(vehicleId: string, email: string): Promise<void> {
    await deleteDoc(doc(this.db, 'invites', inviteKey(this.me.uid, vehicleId, email)));
  }

  async invitesSent(vehicleId?: string): Promise<Invite[]> {
    const mine = query(collection(this.db, 'invites'), where('ownerUid', '==', this.me.uid));
    // One car's alone, when that is all that is wanted (#89): it used to read
    // every invitation the account had sent and filter here. Two equality
    // filters need no composite index.
    const found = await getDocsFromServer(
      vehicleId === undefined ? mine : query(mine, where('vehicleId', '==', vehicleId)),
    );
    return found.docs.flatMap((d) => asInvite(d.data()) ?? []);
  }

  async members(ownerUid: string, vehicleId: string): Promise<Member[]> {
    const found = await getDocsFromServer(collection(this.db, 'users', ownerUid, 'vehicles', vehicleId, 'members'));
    return found.docs.flatMap((d) => asMember(d.data()) ?? []);
  }

  async removeMember(vehicleId: string, memberUid: string): Promise<void> {
    // Their invitation goes too, if an older build joined without using it up
    // (#80): left behind, it let them join again. Looked up rather than
    // deleted blind, because the rules refuse deleting one that is not there.
    const member = (await this.members(this.me.uid, vehicleId)).find((m) => m.uid === memberUid);
    const leftover =
      member === undefined ? [] : (await this.invitesSent(vehicleId)).filter((i) => i.email === member.email);
    const batch = writeBatch(this.db);
    batch.delete(doc(this.db, 'users', this.me.uid, 'vehicles', vehicleId, 'members', memberUid));
    for (const invite of leftover)
      batch.delete(doc(this.db, 'invites', inviteKey(invite.ownerUid, invite.vehicleId, invite.email)));
    await batch.commit();
  }

  async endSharing(vehicleId: string): Promise<void> {
    const [members, ofCar] = await Promise.all([this.members(this.me.uid, vehicleId), this.invitesSent(vehicleId)]);
    if (members.length === 0 && ofCar.length === 0) return;
    const batch = writeBatch(this.db);
    for (const member of members)
      batch.delete(doc(this.db, 'users', this.me.uid, 'vehicles', vehicleId, 'members', member.uid));
    for (const invite of ofCar)
      batch.delete(doc(this.db, 'invites', inviteKey(invite.ownerUid, invite.vehicleId, invite.email)));
    await batch.commit();
  }

  async invitesForMe(): Promise<Invite[]> {
    const email = this.verifiedEmail();
    // An unverified address could be anybody's, and the rules say so too.
    if (email === null) return [];
    const found = await getDocsFromServer(query(collection(this.db, 'invites'), where('email', '==', email)));
    return found.docs.flatMap((d) => asInvite(d.data()) ?? []);
  }

  async accept(invite: Invite): Promise<Membership> {
    const email = this.verifiedEmail();
    if (email === null || email !== invite.email) throw new Refused('accept someone else’s invitation');
    const membership: Membership = {
      ownerUid: invite.ownerUid,
      vehicleId: invite.vehicleId,
      // Read from the account, so bounded again rather than trusted (#86).
      ownerName: boundText(invite.ownerName, TEXT_LIMITS.ownerName),
      vehicleName: boundText(invite.vehicleName, TEXT_LIMITS.vehicleName),
    };
    // One batch (#80): the join, this account's record of it, and the
    // invitation used up. The rules refuse a join that leaves the invitation
    // behind — it let a removed member join again — and a batch also means a
    // failure part-way leaves nothing half-done.
    const batch = writeBatch(this.db);
    batch.set(doc(this.db, 'users', invite.ownerUid, 'vehicles', invite.vehicleId, 'members', this.me.uid), {
      uid: this.me.uid,
      // The rules' `label(name, 200)`, the limit `TEXT_LIMITS.name` mirrors.
      name: boundText(this.me.name, TEXT_LIMITS.name),
      email,
      joinedAt: Date.now(),
    });
    batch.set(doc(this.db, 'users', this.me.uid, 'memberships', membershipKey(membership)), { ...membership });
    batch.delete(doc(this.db, 'invites', inviteKey(invite.ownerUid, invite.vehicleId, invite.email)));
    await batch.commit();
    return membership;
  }

  async decline(invite: Invite): Promise<void> {
    await deleteDoc(doc(this.db, 'invites', inviteKey(invite.ownerUid, invite.vehicleId, invite.email)));
  }

  async memberships(): Promise<Membership[]> {
    const found = await getDocsFromServer(collection(this.db, 'users', this.me.uid, 'memberships'));
    return parseLedger(found.docs.map((d) => d.data()));
  }

  async leave(membership: Membership): Promise<void> {
    await deleteDoc(
      doc(this.db, 'users', membership.ownerUid, 'vehicles', membership.vehicleId, 'members', this.me.uid),
    );
    await deleteDoc(doc(this.db, 'users', this.me.uid, 'memberships', membershipKey(membership)));
  }

  scoped(membership: Membership): RemoteStore {
    return new FirestoreScopedRemote(this.db, membership);
  }
}

/** Firestore's "this query needs an index", which a fresh deploy can briefly lack. */
export function isMissingIndex(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && (cause as { code?: unknown }).code === 'failed-precondition';
}

/**
 * Runs the incremental read, and the full one instead if the index it needs is
 * not ready yet. `vehicleId ==` with `syncedAt >` needs the composite index in
 * `firestore.indexes.json`; a new index takes minutes to build after a deploy,
 * and a member's sync should not fail for those minutes — it reads the whole
 * car instead, which is correct, only less economical.
 */
export async function withIndexFallback<T>(
  incremental: () => Promise<T>,
  full: () => Promise<T>,
  /** Told when it falls back (#89): silent, it cost a full read every sync and nobody knew. */
  onFallback: () => void = () => {},
): Promise<T> {
  try {
    return await incremental();
  } catch (cause) {
    if (!isMissingIndex(cause)) throw cause;
    onFallback();
    return full();
  }
}

/**
 * The owner's account, narrowed to one shared car: what a member's sync of
 * that car talks to. Reads the car and **its** fill-ups — the only query the
 * rules allow a member, `where vehicleId == <car>` — and writes fill-ups only.
 */
export class FirestoreScopedRemote implements RemoteStore {
  constructor(
    private readonly db: Firestore,
    private readonly share: Membership,
  ) {}

  async pull(since: PullCursor | null = null): Promise<RawSnapshot> {
    const { ownerUid, vehicleId } = this.share;
    const all = query(collection(this.db, 'users', ownerUid, 'fillUps'), where('vehicleId', '==', vehicleId));
    const mark = since?.fillUps ?? null;
    const read = (target: Query) => getDocsFromServer(target);
    let indexMissing = false;
    // The car itself is one document, read whole every time — alongside its
    // fill-ups rather than before them (#89).
    const [car, found] = await Promise.all([
      getDocFromServer(doc(this.db, 'users', ownerUid, 'vehicles', vehicleId)),
      mark === null
        ? read(all)
        : withIndexFallback(
            () => read(query(all, where('syncedAt', '>', fromMicros(mark)))),
            () => read(all),
            () => {
              indexMissing = true;
            },
          ),
    ]);
    const { rows: fillUps, highWater } = readStamped(found.docs);
    return {
      vehicles: car.exists() ? [decode(car.data())] : [],
      fillUps,
      pendingFillUps: [],
      // The car is read in full each time, so it carries no mark of its own.
      highWater: { vehicles: null, fillUps: highWater, pendingFillUps: null },
      ...(indexMissing ? { indexMissing: true } : {}),
    };
  }

  async push(snapshot: Snapshot): Promise<PushSummary> {
    if (snapshot.vehicles.length > 0 || snapshot.pendingFillUps.length > 0) {
      throw new Refused('a member writes fill-ups only');
    }
    let receiptsOmitted = 0;
    const writes = snapshot.fillUps.map((row) => {
      const { data, omitted } = encodeReceipt(row);
      if (omitted) receiptsOmitted += 1;
      return { ref: doc(this.db, 'users', this.share.ownerUid, 'fillUps', row.id), data };
    });
    return { written: await writeStamped(this.db, writes), receiptsOmitted };
  }
}
