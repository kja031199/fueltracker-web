/**
 * Sharing a car, against Firestore (#66). The in-memory version, which the
 * rest of the suite uses, is in `../sharing.ts`; this one is exercised against
 * the real `firestore.rules` on the emulator in `sharing.test.ts`.
 *
 * Every write here is one the rules check on their own — this class is a
 * convenience, not the boundary. A forged invitation, a join without one, a
 * fill-up moved to a private car: each is refused by `firestore.rules`
 * whatever any client sends.
 */

import {
  Timestamp,
  collection,
  deleteDoc,
  doc,
  getDocFromServer,
  getDocsFromServer,
  query,
  serverTimestamp,
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
import { parseLedger } from '../syncState';
import { decode, encodeReceipt, fromMicros, toMicros } from './remoteStore';
import { firebaseApp, type FirebaseSettings } from './config';

const BATCH_LIMIT = 500;

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function asInvite(data: DocumentData): Invite | null {
  const ownerUid = text(data['ownerUid']);
  const vehicleId = text(data['vehicleId']);
  const email = text(data['email']);
  if (ownerUid === '' || vehicleId === '' || email === '') return null;
  return {
    ownerUid,
    vehicleId,
    email,
    ownerName: text(data['ownerName']),
    vehicleName: text(data['vehicleName']),
    createdAt: finite(data['createdAt']),
  };
}

function asMember(data: DocumentData): Member | null {
  const uid = text(data['uid']);
  if (uid === '') return null;
  return { uid, name: text(data['name']), email: text(data['email']), joinedAt: finite(data['joinedAt']) };
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
      ownerName: this.me.name,
      vehicleName: vehicle.name,
      createdAt: Date.now(),
    };
    await setDoc(doc(this.db, 'invites', inviteKey(this.me.uid, vehicle.id, email)), { ...invite });
    return invite;
  }

  async withdrawInvite(vehicleId: string, email: string): Promise<void> {
    await deleteDoc(doc(this.db, 'invites', inviteKey(this.me.uid, vehicleId, email)));
  }

  async invitesSent(): Promise<Invite[]> {
    const found = await getDocsFromServer(
      query(collection(this.db, 'invites'), where('ownerUid', '==', this.me.uid)),
    );
    return found.docs.flatMap((d) => asInvite(d.data()) ?? []);
  }

  async members(ownerUid: string, vehicleId: string): Promise<Member[]> {
    const found = await getDocsFromServer(
      collection(this.db, 'users', ownerUid, 'vehicles', vehicleId, 'members'),
    );
    return found.docs.flatMap((d) => asMember(d.data()) ?? []);
  }

  async removeMember(vehicleId: string, memberUid: string): Promise<void> {
    await deleteDoc(doc(this.db, 'users', this.me.uid, 'vehicles', vehicleId, 'members', memberUid));
  }

  async invitesForMe(): Promise<Invite[]> {
    const email = this.verifiedEmail();
    // An unverified address could be anybody's, and the rules say so too.
    if (email === null) return [];
    const found = await getDocsFromServer(
      query(collection(this.db, 'invites'), where('email', '==', email)),
    );
    return found.docs.flatMap((d) => asInvite(d.data()) ?? []);
  }

  async accept(invite: Invite): Promise<Membership> {
    const email = this.verifiedEmail();
    if (email === null || email !== invite.email) throw new Refused('accept someone else’s invitation');
    // Order matters: joining needs the invitation to exist, so it is used up
    // last. A failure part-way leaves something a retry can finish.
    await setDoc(doc(this.db, 'users', invite.ownerUid, 'vehicles', invite.vehicleId, 'members', this.me.uid), {
      uid: this.me.uid,
      name: this.me.name,
      email,
      joinedAt: Date.now(),
    });
    const membership: Membership = {
      ownerUid: invite.ownerUid,
      vehicleId: invite.vehicleId,
      ownerName: invite.ownerName,
      vehicleName: invite.vehicleName,
    };
    await setDoc(doc(this.db, 'users', this.me.uid, 'memberships', membershipKey(membership)), { ...membership });
    await deleteDoc(doc(this.db, 'invites', inviteKey(invite.ownerUid, invite.vehicleId, invite.email)));
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
  return (
    typeof cause === 'object' &&
    cause !== null &&
    (cause as { code?: unknown }).code === 'failed-precondition'
  );
}

/**
 * Runs the incremental read, and the full one instead if the index it needs is
 * not ready yet. `vehicleId ==` with `syncedAt >` needs the composite index in
 * `firestore.indexes.json`; a new index takes minutes to build after a deploy,
 * and a member's sync should not fail for those minutes — it reads the whole
 * car instead, which is correct, only less economical.
 */
export async function withIndexFallback<T>(incremental: () => Promise<T>, full: () => Promise<T>): Promise<T> {
  try {
    return await incremental();
  } catch (cause) {
    if (isMissingIndex(cause)) return full();
    throw cause;
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
    // The car itself is one document, read whole every time.
    const car = await getDocFromServer(doc(this.db, 'users', ownerUid, 'vehicles', vehicleId));
    const all = query(collection(this.db, 'users', ownerUid, 'fillUps'), where('vehicleId', '==', vehicleId));
    const mark = since?.fillUps ?? null;
    const read = (target: Query) => getDocsFromServer(target);
    const found =
      mark === null
        ? await read(all)
        : await withIndexFallback(
            () => read(query(all, where('syncedAt', '>', fromMicros(mark)))),
            () => read(all),
          );
    let highWater: number | null = null;
    const fillUps = found.docs.map((d) => {
      const data = d.data();
      const stamp = data['syncedAt'];
      if (stamp instanceof Timestamp) highWater = Math.max(highWater ?? 0, toMicros(stamp));
      return decode(data);
    });
    return {
      vehicles: car.exists() ? [decode(car.data())] : [],
      fillUps,
      pendingFillUps: [],
      // The car is read in full each time, so it carries no mark of its own.
      highWater: { vehicles: null, fillUps: highWater, pendingFillUps: null },
    };
  }

  async push(snapshot: Snapshot): Promise<PushSummary> {
    if (snapshot.vehicles.length > 0 || snapshot.pendingFillUps.length > 0) {
      throw new Refused('a member writes fill-ups only');
    }
    let receiptsOmitted = 0;
    const rows = snapshot.fillUps.map((row) => {
      const { data, omitted } = encodeReceipt(row);
      if (omitted) receiptsOmitted += 1;
      return { id: row.id, data };
    });
    for (let start = 0; start < rows.length; start += BATCH_LIMIT) {
      const batch = writeBatch(this.db);
      for (const row of rows.slice(start, start + BATCH_LIMIT)) {
        batch.set(doc(this.db, 'users', this.share.ownerUid, 'fillUps', row.id), {
          ...row.data,
          syncedAt: serverTimestamp(),
        });
      }
      await batch.commit();
    }
    return { written: rows.length, receiptsOmitted };
  }
}
