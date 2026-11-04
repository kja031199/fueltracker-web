import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  where,
  type Firestore,
} from 'firebase/firestore';
import { InMemoryRepository } from '../repository';
import type { FillUpRecord, PendingFillUpRecord, VehicleRecord } from '../records';
import { FuelTrackerStore } from '../store';
import { makeFuelEntryDraft } from '../../domain/fuelEntryDraft';

/**
 * The one exception to "your own tree, nobody else's": a shared car (#66).
 *
 * Every positive case here is matched by the negative that bounds it — a
 * member can read *this* car and nothing else of the owner's, can write *its*
 * fill-ups and cannot move one out of it, can join only with an invitation to
 * their own verified address. Run against the real `firestore.rules` on the
 * emulator, with documents shaped exactly as the app writes them.
 */

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const describeWithEmulator = describe.skipIf(HOST === undefined);

function allowedUidsInRules(): string[] {
  const source = readFileSync('firestore.rules', 'utf8');
  const block = /function allowed\(\)[\s\S]*?\[([\s\S]*?)\]/.exec(source);
  if (block === null) throw new Error('firestore.rules has no allowed() list');
  return [...block[1]!.matchAll(/'([^']*)'/g)].map((match) => match[1]!);
}

const ALLOWED = allowedUidsInRules();
const OWNER = ALLOWED[0]!;
/** The second allowlisted account: the partner being invited. */
const PARTNER = ALLOWED[1]!;
const STRANGER = 'uid-that-is-not-on-the-allowlist';

const OWNER_EMAIL = 'owner@example.com';
const PARTNER_EMAIL = 'partner@example.com';
const SHARED = 'car-shared';
const PRIVATE = 'car-private';

const inviteId = (vehicleId: string, email: string): string => `${OWNER}__${vehicleId}__${email}`;

async function records(): Promise<{ vehicle: VehicleRecord; fillUp: FillUpRecord }> {
  const store = new FuelTrackerStore({
    vehicles: new InMemoryRepository<VehicleRecord>(),
    fillUps: new InMemoryRepository<FillUpRecord>(),
    pendingFillUps: new InMemoryRepository<PendingFillUpRecord>(),
  });
  const vehicle = await store.addVehicle({ name: 'Civic' });
  const draft = makeFuelEntryDraft({ date: new Date(1_700_000_000_000), odometer: 10_000, gallons: 10, pricePerGallon: 3.5 });
  if (draft === null) throw new Error('fixture draft failed validation');
  const fillUp = await store.addFillUp(draft, vehicle.id);
  return { vehicle, fillUp };
}

/** A fill-up as the app sends it, for `vehicleId`, entered by `enteredBy`. */
async function fillUpFor(id: string, vehicleId: string, enteredBy: string | null): Promise<Record<string, unknown>> {
  const { fillUp } = await records();
  return { ...fillUp, id, vehicleId, enteredBy, syncedAt: serverTimestamp() };
}

describeWithEmulator('sharing a car (#66)', () => {
  let env: RulesTestEnvironment;

  const as = (uid: string, email: string, verified = true): Firestore =>
    env.authenticatedContext(uid, { email, email_verified: verified }).firestore();
  const owner = (): Firestore => as(OWNER, OWNER_EMAIL);
  const partner = (): Firestore => as(PARTNER, PARTNER_EMAIL);
  const stranger = (): Firestore => as(STRANGER, 'stranger@example.com');

  const invite = (vehicleId = SHARED, email = PARTNER_EMAIL): Record<string, unknown> => ({
    ownerUid: OWNER,
    vehicleId,
    email,
    ownerName: 'Owner',
    vehicleName: 'Civic',
    createdAt: 1,
  });
  const membership = (): Record<string, unknown> => ({
    uid: PARTNER,
    name: 'Partner',
    email: PARTNER_EMAIL,
    joinedAt: 1,
  });

  async function join(): Promise<void> {
    await assertSucceeds(setDoc(doc(owner(), `invites/${inviteId(SHARED, PARTNER_EMAIL)}`), invite()));
    await assertSucceeds(setDoc(doc(partner(), `users/${OWNER}/vehicles/${SHARED}/members/${PARTNER}`), membership()));
  }

  beforeAll(async () => {
    const [host, port] = (HOST ?? 'localhost:8080').split(':');
    env = await initializeTestEnvironment({
      projectId: 'fueltracker-sharing-test',
      firestore: { rules: readFileSync('firestore.rules', 'utf8'), host, port: Number(port) },
    });
  });

  beforeEach(async () => {
    await env.clearFirestore();
    const { vehicle } = await records();
    await env.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, `users/${OWNER}/vehicles/${SHARED}`), { ...vehicle, id: SHARED });
      await setDoc(doc(db, `users/${OWNER}/vehicles/${PRIVATE}`), { ...vehicle, id: PRIVATE });
      await setDoc(doc(db, `users/${OWNER}/vehicles/gone`), { ...vehicle, id: 'gone', deletedAt: 5 });
      await setDoc(doc(db, `users/${OWNER}/fillUps/on-shared`), await fillUpFor('on-shared', SHARED, OWNER));
      await setDoc(doc(db, `users/${OWNER}/fillUps/on-private`), await fillUpFor('on-private', PRIVATE, OWNER));
      await setDoc(doc(db, `users/${OWNER}/pendingFillUps/p1`), { id: 'p1', vehicleId: SHARED });
    });
  });

  afterAll(async () => {
    await env?.cleanup();
  });

  it('there are two allowlisted accounts to test with', () => {
    expect(ALLOWED.length).toBeGreaterThanOrEqual(2);
  });

  describe('invitations', () => {
    it('the owner can invite an address to a car of their own', async () => {
      await assertSucceeds(setDoc(doc(owner(), `invites/${inviteId(SHARED, PARTNER_EMAIL)}`), invite()));
    });

    it('an invitation is never rewritten in place — withdraw it and send another', async () => {
      // No update rule: an invitation that could be edited after it was sent
      // could be pointed at a different car under the same id.
      const id = inviteId(SHARED, PARTNER_EMAIL);
      await assertSucceeds(setDoc(doc(owner(), `invites/${id}`), invite()));
      await assertFails(setDoc(doc(owner(), `invites/${id}`), { ...invite(), vehicleName: 'Renamed' }));
    });

    it('not to a car they do not have, or one they deleted', async () => {
      await assertFails(setDoc(doc(owner(), `invites/${inviteId('nope', PARTNER_EMAIL)}`), invite('nope')));
      await assertFails(setDoc(doc(owner(), `invites/${inviteId('gone', PARTNER_EMAIL)}`), invite('gone')));
    });

    it('not under an id that does not match what it says', async () => {
      await assertFails(setDoc(doc(owner(), `invites/${inviteId(PRIVATE, PARTNER_EMAIL)}`), invite()));
    });

    it('not with an address in capitals, which no verified token would match', async () => {
      const shouting = 'Partner@Example.com';
      await assertFails(setDoc(doc(owner(), `invites/${OWNER}__${SHARED}__${shouting}`), invite(SHARED, shouting)));
    });

    it('not with an extra field', async () => {
      await assertFails(
        setDoc(doc(owner(), `invites/${inviteId(SHARED, PARTNER_EMAIL)}`), { ...invite(), role: 'owner' }),
      );
    });

    it('nobody can forge an invitation from someone else', async () => {
      // The partner inviting themselves into the owner's car.
      await assertFails(setDoc(doc(partner(), `invites/${inviteId(SHARED, PARTNER_EMAIL)}`), invite()));
      await assertFails(setDoc(doc(stranger(), `invites/${inviteId(SHARED, 'stranger@example.com')}`), invite(SHARED, 'stranger@example.com')));
    });

    it('the invitee finds it by their verified address, whatever its case', async () => {
      await join();
      await setDoc(doc(owner(), `invites/${inviteId(PRIVATE, PARTNER_EMAIL)}`), invite(PRIVATE));
      const shouty = as(PARTNER, 'PARTNER@EXAMPLE.COM');
      await assertSucceeds(getDocs(query(collection(shouty, 'invites'), where('email', '==', PARTNER_EMAIL))));
    });

    it('an unverified address cannot read it', async () => {
      await setDoc(doc(owner(), `invites/${inviteId(SHARED, PARTNER_EMAIL)}`), invite());
      const unverified = as(PARTNER, PARTNER_EMAIL, false);
      await assertFails(getDocs(query(collection(unverified, 'invites'), where('email', '==', PARTNER_EMAIL))));
    });

    it('nobody else can list someone else’s invitations', async () => {
      await setDoc(doc(owner(), `invites/${inviteId(SHARED, PARTNER_EMAIL)}`), invite());
      await assertFails(getDocs(query(collection(stranger(), 'invites'), where('email', '==', PARTNER_EMAIL))));
      await assertFails(getDocs(collection(partner(), 'invites')));
    });

    it('the owner can withdraw it and the invitee can decline it; nobody else can delete it', async () => {
      const id = inviteId(SHARED, PARTNER_EMAIL);
      await setDoc(doc(owner(), `invites/${id}`), invite());
      await assertFails(deleteDoc(doc(stranger(), `invites/${id}`)));
      await assertSucceeds(deleteDoc(doc(partner(), `invites/${id}`)));
      await setDoc(doc(owner(), `invites/${id}`), invite());
      await assertSucceeds(deleteDoc(doc(owner(), `invites/${id}`)));
    });
  });

  describe('joining', () => {
    it('is refused without an invitation', async () => {
      await assertFails(setDoc(doc(partner(), `users/${OWNER}/vehicles/${SHARED}/members/${PARTNER}`), membership()));
    });

    it('is allowed with one addressed to you', async () => {
      await join();
    });

    it('is refused when the address on the sign-in is not verified', async () => {
      await setDoc(doc(owner(), `invites/${inviteId(SHARED, PARTNER_EMAIL)}`), invite());
      const unverified = as(PARTNER, PARTNER_EMAIL, false);
      await assertFails(setDoc(doc(unverified, `users/${OWNER}/vehicles/${SHARED}/members/${PARTNER}`), membership()));
    });

    it('an invitation to one car does not open another', async () => {
      await setDoc(doc(owner(), `invites/${inviteId(SHARED, PARTNER_EMAIL)}`), invite());
      await assertFails(setDoc(doc(partner(), `users/${OWNER}/vehicles/${PRIVATE}/members/${PARTNER}`), membership()));
    });

    it('someone else cannot use your invitation, or add you, or add anyone', async () => {
      await setDoc(doc(owner(), `invites/${inviteId(SHARED, PARTNER_EMAIL)}`), invite());
      // A stranger presenting the partner's address but a different account.
      const impostor = as(STRANGER, PARTNER_EMAIL);
      await assertFails(setDoc(doc(impostor, `users/${OWNER}/vehicles/${SHARED}/members/${STRANGER}`), { ...membership(), uid: STRANGER }));
      await assertSucceeds(setDoc(doc(partner(), `users/${OWNER}/vehicles/${SHARED}/members/${PARTNER}`), membership()));
      // A member cannot add a third person.
      await assertFails(setDoc(doc(partner(), `users/${OWNER}/vehicles/${SHARED}/members/${STRANGER}`), { ...membership(), uid: STRANGER }));
    });

    it('cannot claim another address in the membership', async () => {
      await setDoc(doc(owner(), `invites/${inviteId(SHARED, PARTNER_EMAIL)}`), invite());
      await assertFails(
        setDoc(doc(partner(), `users/${OWNER}/vehicles/${SHARED}/members/${PARTNER}`), { ...membership(), email: 'boss@example.com' }),
      );
    });
  });

  describe('what a member can read', () => {
    it('the shared car and its fill-ups — by query, as sync reads them', async () => {
      await join();
      const db = partner();
      await assertSucceeds(getDoc(doc(db, `users/${OWNER}/vehicles/${SHARED}`)));
      await assertSucceeds(getDoc(doc(db, `users/${OWNER}/fillUps/on-shared`)));
      await assertSucceeds(getDocs(query(collection(db, `users/${OWNER}/fillUps`), where('vehicleId', '==', SHARED))));
      await assertSucceeds(getDocs(query(collection(db, `users/${OWNER}/fillUps`), where('vehicleId', '==', SHARED), where('syncedAt', '>', new Date(0)))));
    });

    it('nothing else of the owner’s', async () => {
      await join();
      const db = partner();
      await assertFails(getDoc(doc(db, `users/${OWNER}/vehicles/${PRIVATE}`)));
      await assertFails(getDoc(doc(db, `users/${OWNER}/fillUps/on-private`)));
      await assertFails(getDocs(collection(db, `users/${OWNER}/fillUps`)));
      await assertFails(getDocs(collection(db, `users/${OWNER}/vehicles`)));
      await assertFails(getDocs(query(collection(db, `users/${OWNER}/fillUps`), where('vehicleId', '==', PRIVATE))));
      await assertFails(getDoc(doc(db, `users/${OWNER}/pendingFillUps/p1`)));
      await assertFails(getDoc(doc(db, `users/${OWNER}`)));
    });

    it('an allowlisted account that has not joined reads nothing', async () => {
      const db = partner();
      await assertFails(getDoc(doc(db, `users/${OWNER}/vehicles/${SHARED}`)));
      await assertFails(getDocs(query(collection(db, `users/${OWNER}/fillUps`), where('vehicleId', '==', SHARED))));
    });

    it('the member list of their car, so a fill-up can say who logged it', async () => {
      await join();
      await assertSucceeds(getDocs(collection(partner(), `users/${OWNER}/vehicles/${SHARED}/members`)));
      await assertFails(getDocs(collection(stranger(), `users/${OWNER}/vehicles/${SHARED}/members`)));
    });
  });

  describe('what a member can write', () => {
    it('a new fill-up on the shared car, entered by themselves', async () => {
      await join();
      await assertSucceeds(setDoc(doc(partner(), `users/${OWNER}/fillUps/new`), await fillUpFor('new', SHARED, PARTNER)));
    });

    it('not one claiming someone else entered it, or with nobody named', async () => {
      await join();
      await assertFails(setDoc(doc(partner(), `users/${OWNER}/fillUps/new`), await fillUpFor('new', SHARED, OWNER)));
      await assertFails(setDoc(doc(partner(), `users/${OWNER}/fillUps/new`), await fillUpFor('new', SHARED, null)));
    });

    it('not one on another car, and not by moving an existing one there', async () => {
      await join();
      await assertFails(setDoc(doc(partner(), `users/${OWNER}/fillUps/new`), await fillUpFor('new', PRIVATE, PARTNER)));
      await assertFails(setDoc(doc(partner(), `users/${OWNER}/fillUps/on-shared`), await fillUpFor('on-shared', PRIVATE, OWNER)));
      await assertFails(setDoc(doc(partner(), `users/${OWNER}/fillUps/on-private`), await fillUpFor('on-private', SHARED, OWNER)));
    });

    it('an edit to an existing one, without changing who entered it', async () => {
      await join();
      const edited = { ...(await fillUpFor('on-shared', SHARED, OWNER)), odometer: 12_345 };
      await assertSucceeds(setDoc(doc(partner(), `users/${OWNER}/fillUps/on-shared`), edited));
      await assertFails(setDoc(doc(partner(), `users/${OWNER}/fillUps/on-shared`), { ...edited, enteredBy: PARTNER }));
    });

    it('still the shape every write must have', async () => {
      await join();
      await assertFails(setDoc(doc(partner(), `users/${OWNER}/fillUps/new`), { ...(await fillUpFor('new', SHARED, PARTNER)), extra: 1 }));
      await assertFails(setDoc(doc(partner(), `users/${OWNER}/fillUps/new`), { ...(await fillUpFor('new', SHARED, PARTNER)), syncedAt: new Date() }));
    });

    it('never the car itself, or anything else of the owner’s', async () => {
      await join();
      const { vehicle } = await records();
      await assertFails(setDoc(doc(partner(), `users/${OWNER}/vehicles/${SHARED}`), { ...vehicle, id: SHARED, syncedAt: serverTimestamp() }));
      await assertFails(setDoc(doc(partner(), `users/${OWNER}/pendingFillUps/p2`), { id: 'p2' }));
    });
  });

  describe('the owner', () => {
    it('can still write their own fill-ups, with or without a name on them', async () => {
      await assertSucceeds(setDoc(doc(owner(), `users/${OWNER}/fillUps/mine`), await fillUpFor('mine', SHARED, OWNER)));
      await assertSucceeds(setDoc(doc(owner(), `users/${OWNER}/fillUps/old-build`), await fillUpFor('old-build', SHARED, null)));
    });

    it('cannot join their own car', async () => {
      await setDoc(doc(owner(), `invites/${inviteId(SHARED, OWNER_EMAIL)}`), invite(SHARED, OWNER_EMAIL));
      await assertFails(setDoc(doc(owner(), `users/${OWNER}/vehicles/${SHARED}/members/${OWNER}`), { ...membership(), uid: OWNER, email: OWNER_EMAIL }));
    });
  });

  describe('when it ends', () => {
    it('a member can leave, and then reads nothing', async () => {
      await join();
      await assertSucceeds(deleteDoc(doc(partner(), `users/${OWNER}/vehicles/${SHARED}/members/${PARTNER}`)));
      await assertFails(getDocs(query(collection(partner(), `users/${OWNER}/fillUps`), where('vehicleId', '==', SHARED))));
    });

    it('the owner can remove a member, and then they read nothing', async () => {
      await join();
      await assertSucceeds(deleteDoc(doc(owner(), `users/${OWNER}/vehicles/${SHARED}/members/${PARTNER}`)));
      await assertFails(getDoc(doc(partner(), `users/${OWNER}/vehicles/${SHARED}`)));
    });

    it('nobody else can remove a member', async () => {
      await join();
      await assertFails(deleteDoc(doc(stranger(), `users/${OWNER}/vehicles/${SHARED}/members/${PARTNER}`)));
    });
  });

  describe('memberships: the member’s own list of shared cars', () => {
    const entry = (): Record<string, unknown> => ({
      ownerUid: OWNER,
      vehicleId: SHARED,
      ownerName: 'Owner',
      vehicleName: 'Civic',
    });

    it('is theirs to write and read', async () => {
      await assertSucceeds(setDoc(doc(partner(), `users/${PARTNER}/memberships/${OWNER}__${SHARED}`), entry()));
      await assertSucceeds(getDocs(collection(partner(), `users/${PARTNER}/memberships`)));
    });

    it('under an id that matches what it says, with nothing extra', async () => {
      await assertFails(setDoc(doc(partner(), `users/${PARTNER}/memberships/wrong`), entry()));
      await assertFails(setDoc(doc(partner(), `users/${PARTNER}/memberships/${OWNER}__${SHARED}`), { ...entry(), role: 'owner' }));
    });

    it('and nobody else’s', async () => {
      await assertFails(getDocs(collection(owner(), `users/${PARTNER}/memberships`)));
      await assertFails(setDoc(doc(owner(), `users/${PARTNER}/memberships/${OWNER}__${SHARED}`), entry()));
    });
  });
});
