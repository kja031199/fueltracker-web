import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeStore } from '../../test/fixtures';
import { allowedUidsInRules, rulesEnvironment, signedIn } from '../../test/emulator';
import {
  assertFails,
  assertSucceeds,
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
  writeBatch,
} from 'firebase/firestore';
import type { FillUpRecord, VehicleRecord } from '../records';
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
  const store = makeStore();
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

describe('sharing a car (#66)', () => {
  let env: RulesTestEnvironment;

  const as = (uid: string, email: string, verified = true) =>
    signedIn(env, uid, { email, email_verified: verified }).firestore();
  const owner = () => as(OWNER, OWNER_EMAIL);
  const partner = () => as(PARTNER, PARTNER_EMAIL);
  const stranger = () => as(STRANGER, 'stranger@example.com');

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

  /**
   * Joining as the app does it (#80): the member document and the invitation
   * it uses up, in one batch — the rules refuse a join that leaves the
   * invitation behind, so it cannot be used again after a removal.
   */
  function joining(
    db: ReturnType<typeof partner>,
    options: { car?: string; uid?: string; data?: Record<string, unknown>; inviteCar?: string } = {},
  ): Promise<void> {
    const { car = SHARED, uid = PARTNER, data = membership(), inviteCar = SHARED } = options;
    const batch = writeBatch(db);
    batch.set(doc(db, `users/${OWNER}/vehicles/${car}/members/${uid}`), data);
    batch.delete(doc(db, `invites/${inviteId(inviteCar, PARTNER_EMAIL)}`));
    return batch.commit();
  }

  async function join(): Promise<void> {
    await assertSucceeds(setDoc(doc(owner(), `invites/${inviteId(SHARED, PARTNER_EMAIL)}`), invite()));
    await assertSucceeds(joining(partner()));
  }

  beforeAll(async () => {
    env = await rulesEnvironment('fueltracker-sharing-test');
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
      await assertFails(joining(unverified));
    });

    it('an invitation to one car does not open another', async () => {
      await setDoc(doc(owner(), `invites/${inviteId(SHARED, PARTNER_EMAIL)}`), invite());
      await assertFails(joining(partner(), { car: PRIVATE }));
    });

    it('someone else cannot use your invitation, or add you, or add anyone', async () => {
      await setDoc(doc(owner(), `invites/${inviteId(SHARED, PARTNER_EMAIL)}`), invite());
      // A stranger presenting the partner's address but a different account.
      const impostor = as(STRANGER, PARTNER_EMAIL);
      await assertFails(joining(impostor, { uid: STRANGER, data: { ...membership(), uid: STRANGER } }));
      await assertSucceeds(joining(partner()));
      // A member cannot add a third person.
      await assertFails(setDoc(doc(partner(), `users/${OWNER}/vehicles/${SHARED}/members/${STRANGER}`), { ...membership(), uid: STRANGER }));
    });

    // #78: a car's id is not secret, and an owner can file a car under any
    // id. Joining a car whose id names one of your own would make your own
    // fill-ups sync into the inviter's account.
    it('is refused when your own account already has a car with that id', async () => {
      const { vehicle } = await records();
      await env.withSecurityRulesDisabled(async (context) => {
        await setDoc(doc(context.firestore(), `users/${PARTNER}/vehicles/${SHARED}`), { ...vehicle, id: SHARED });
      });
      await setDoc(doc(owner(), `invites/${inviteId(SHARED, PARTNER_EMAIL)}`), invite());
      await assertFails(joining(partner()));
    });

    it('…including one you deleted, whose tombstone still names it', async () => {
      const { vehicle } = await records();
      await env.withSecurityRulesDisabled(async (context) => {
        await setDoc(doc(context.firestore(), `users/${PARTNER}/vehicles/${SHARED}`), { ...vehicle, id: SHARED, deletedAt: 5 });
      });
      await setDoc(doc(owner(), `invites/${inviteId(SHARED, PARTNER_EMAIL)}`), invite());
      await assertFails(joining(partner()));
    });

    it('a car of yours with a different id does not get in the way', async () => {
      const { vehicle } = await records();
      await env.withSecurityRulesDisabled(async (context) => {
        await setDoc(doc(context.firestore(), `users/${PARTNER}/vehicles/my-own`), { ...vehicle, id: 'my-own' });
      });
      await join();
    });

    // #80: an invitation is single-use, enforced here rather than trusted to
    // the client that is joining.
    it('is refused when the join leaves the invitation behind', async () => {
      await setDoc(doc(owner(), `invites/${inviteId(SHARED, PARTNER_EMAIL)}`), invite());
      await assertFails(setDoc(doc(partner(), `users/${OWNER}/vehicles/${SHARED}/members/${PARTNER}`), membership()));
    });

    it('uses the invitation up: it is gone once joined', async () => {
      await join();
      let left = true;
      await env.withSecurityRulesDisabled(async (context) => {
        left = (await getDoc(doc(context.firestore(), `invites/${inviteId(SHARED, PARTNER_EMAIL)}`))).exists();
      });
      expect(left).toBe(false);
    });

    it('cannot be repeated after the owner removes you: there is nothing left to join with', async () => {
      await join();
      await assertSucceeds(deleteDoc(doc(owner(), `users/${OWNER}/vehicles/${SHARED}/members/${PARTNER}`)));
      await assertFails(joining(partner()));
      await assertFails(setDoc(doc(partner(), `users/${OWNER}/vehicles/${SHARED}/members/${PARTNER}`), membership()));
    });

    it('is refused for a car deleted since the invitation was sent', async () => {
      await setDoc(doc(owner(), `invites/${inviteId(SHARED, PARTNER_EMAIL)}`), invite());
      const { vehicle } = await records();
      await env.withSecurityRulesDisabled(async (context) => {
        await setDoc(doc(context.firestore(), `users/${OWNER}/vehicles/${SHARED}`), { ...vehicle, id: SHARED, deletedAt: 5 });
      });
      await assertFails(joining(partner()));
    });

    it('cannot claim another address in the membership', async () => {
      await setDoc(doc(owner(), `invites/${inviteId(SHARED, PARTNER_EMAIL)}`), invite());
      await assertFails(joining(partner(), { data: { ...membership(), email: 'boss@example.com' } }));
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

  // #79: a member stamping the owner's fill-up a year ahead made it
  // impossible for the owner to edit or delete again.
  describe('a member cannot lock a fill-up with a far-future stamp (#79)', () => {
    const DAY = 24 * 60 * 60 * 1000;

    it('refuses the owner\u2019s fill-up restamped a year ahead, as an edit or as a deletion', async () => {
      await join();
      const ref = doc(partner(), `users/${OWNER}/fillUps/on-shared`);
      const theirs = await fillUpFor('on-shared', SHARED, OWNER);
      await assertFails(setDoc(ref, { ...theirs, odometer: 99_999, updatedAt: Date.now() + 365 * DAY }));
      await assertFails(setDoc(ref, { ...theirs, deletedAt: Date.now(), updatedAt: Date.now() + 365 * DAY }));
    });

    it('still lets them edit it with an honest stamp', async () => {
      await join();
      const theirs = await fillUpFor('on-shared', SHARED, OWNER);
      await assertSucceeds(setDoc(doc(partner(), `users/${OWNER}/fillUps/on-shared`), { ...theirs, odometer: 10_050, updatedAt: Date.now() }));
    });

    it('refuses taking the owner\u2019s stamp backwards, and allows the same stamp again', async () => {
      await join();
      const theirs = { ...(await fillUpFor('on-shared', SHARED, OWNER)), updatedAt: 5_000 };
      await env.withSecurityRulesDisabled(async (context) => {
        await setDoc(doc(context.firestore(), `users/${OWNER}/fillUps/on-shared`), theirs);
      });
      const ref = doc(partner(), `users/${OWNER}/fillUps/on-shared`);
      await assertFails(setDoc(ref, { ...theirs, odometer: 10_050, updatedAt: 4_999 }));
      await assertSucceeds(setDoc(ref, { ...theirs, updatedAt: 5_000 }));
    });

    it('refuses a membership whose join time is not a finite number', async () => {
      await setDoc(doc(owner(), `invites/${inviteId(SHARED, PARTNER_EMAIL)}`), invite());
      await assertFails(joining(partner(), { data: { ...membership(), joinedAt: Number.NaN } }));
      await assertFails(joining(partner(), { data: { ...membership(), joinedAt: Number.POSITIVE_INFINITY } }));
    });

    it('refuses an invitation dated infinity', async () => {
      await assertFails(
        setDoc(doc(owner(), `invites/${inviteId(SHARED, PARTNER_EMAIL)}`), { ...invite(), createdAt: Number.POSITIVE_INFINITY }),
      );
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

    // #80: deleting the car ends access on the server, whatever is left over.
    describe('the owner deletes the car', () => {
      async function deleteTheCar(): Promise<void> {
        const { vehicle } = await records();
        await env.withSecurityRulesDisabled(async (context) => {
          await setDoc(doc(context.firestore(), `users/${OWNER}/vehicles/${SHARED}`), { ...vehicle, id: SHARED, deletedAt: 5 });
        });
      }

      it('a member left behind reads nothing of it', async () => {
        await join();
        await deleteTheCar();
        await assertFails(getDoc(doc(partner(), `users/${OWNER}/vehicles/${SHARED}`)));
        await assertFails(getDocs(query(collection(partner(), `users/${OWNER}/fillUps`), where('vehicleId', '==', SHARED))));
      });

      it('…and writes nothing to it', async () => {
        await join();
        await deleteTheCar();
        await assertFails(setDoc(doc(partner(), `users/${OWNER}/fillUps/new`), await fillUpFor('new', SHARED, PARTNER)));
        const theirs = await fillUpFor('on-shared', SHARED, OWNER);
        await assertFails(setDoc(doc(partner(), `users/${OWNER}/fillUps/on-shared`), { ...theirs, odometer: 10_050, updatedAt: Date.now() }));
      });

      it('the owner can still clear its members and invitations', async () => {
        await join();
        await setDoc(doc(owner(), `invites/${inviteId(SHARED, 'third@example.com')}`), invite(SHARED, 'third@example.com'));
        await deleteTheCar();
        await assertSucceeds(deleteDoc(doc(owner(), `users/${OWNER}/vehicles/${SHARED}/members/${PARTNER}`)));
        await assertSucceeds(deleteDoc(doc(owner(), `invites/${inviteId(SHARED, 'third@example.com')}`)));
      });
    });

    it('nobody else can remove a member', async () => {
      await join();
      await assertFails(deleteDoc(doc(stranger(), `users/${OWNER}/vehicles/${SHARED}/members/${PARTNER}`)));
    });
  });

  describe('more hostile cases', () => {
    it('an address too short or too long cannot be invited', async () => {
      await assertFails(setDoc(doc(owner(), `invites/${inviteId(SHARED, 'a@')}`), invite(SHARED, 'a@')));
      const long = `${'a'.repeat(310)}@example.com`;
      await assertFails(setDoc(doc(owner(), `invites/${inviteId(SHARED, long)}`), invite(SHARED, long)));
    });

    it('an invitation must say which car and who sent it, with nothing missing', async () => {
      const id = inviteId(SHARED, PARTNER_EMAIL);
      const { ownerName: _name, ...missing } = invite();
      await assertFails(setDoc(doc(owner(), `invites/${id}`), missing));
      await assertFails(setDoc(doc(owner(), `invites/${id}`), { ...invite(), createdAt: 'yesterday' }));
      await assertFails(setDoc(doc(owner(), `invites/${id}`), { ...invite(), vehicleName: 'x'.repeat(201) }));
    });

    it('someone not on the allowlist cannot join, even with an invitation to their address', async () => {
      const strangerEmail = 'stranger@example.com';
      await assertSucceeds(setDoc(doc(owner(), `invites/${inviteId(SHARED, strangerEmail)}`), invite(SHARED, strangerEmail)));
      await assertFails(
        setDoc(doc(stranger(), `users/${OWNER}/vehicles/${SHARED}/members/${STRANGER}`), {
          ...membership(),
          uid: STRANGER,
          email: strangerEmail,
        }),
      );
    });

    it('a member cannot read the invitations the owner has sent', async () => {
      await join();
      await setDoc(doc(owner(), `invites/${inviteId(PRIVATE, 'someone@example.com')}`), invite(PRIVATE, 'someone@example.com'));
      await assertFails(getDocs(query(collection(partner(), 'invites'), where('ownerUid', '==', OWNER))));
    });

    it('an unverified address cannot decline an invitation either', async () => {
      const id = inviteId(SHARED, PARTNER_EMAIL);
      await setDoc(doc(owner(), `invites/${id}`), invite());
      await assertFails(deleteDoc(doc(as(PARTNER, PARTNER_EMAIL, false), `invites/${id}`)));
    });

    it('a member cannot edit their own membership document', async () => {
      await join();
      await assertFails(
        setDoc(doc(partner(), `users/${OWNER}/vehicles/${SHARED}/members/${PARTNER}`), { ...membership(), name: 'Owner' }),
      );
    });

    it('a member’s fill-up still obeys the receipt size limit', async () => {
      await join();
      const { Bytes } = await import('firebase/firestore');
      const big = { ...(await fillUpFor('big', SHARED, PARTNER)), receiptImageData: Bytes.fromUint8Array(new Uint8Array(716_801)) };
      await assertFails(setDoc(doc(partner(), `users/${OWNER}/fillUps/big`), big));
    });

    it('a member can delete a fill-up — a tombstone that keeps who entered it', async () => {
      await join();
      // Stamped now, as the app stamps a deletion — newer than the version it
      // deletes. (This fixture used to say 9; since #79 a stamp may not go
      // backwards, and a real tombstone never did.)
      const now = Date.now();
      const tombstone = { ...(await fillUpFor('on-shared', SHARED, OWNER)), deletedAt: now, updatedAt: now };
      await assertSucceeds(setDoc(doc(partner(), `users/${OWNER}/fillUps/on-shared`), tombstone));
    });

    it('a member cannot erase a fill-up outright', async () => {
      await join();
      await assertFails(deleteDoc(doc(partner(), `users/${OWNER}/fillUps/on-shared`)));
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
