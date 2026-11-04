import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import type { Firestore } from 'firebase/firestore';
import { InMemoryRepository } from '../repository';
import type { FillUpRecord, PendingFillUpRecord, VehicleRecord } from '../records';
import { FuelTrackerStore } from '../store';
import type { Account } from '../sharing';
import { syncAll, type SharingSync } from '../shareSync';
import { InMemoryShareLedger, InMemorySyncState } from '../syncState';
import { MonotonicClock } from '../syncClock';
import { makeFuelEntryDraft } from '../../domain/fuelEntryDraft';
import { FirestoreRemoteStore } from './remoteStore';
import { FirestoreSharingRemote, isMissingIndex, withIndexFallback } from './sharingRemote';

/**
 * Two people sharing a car (#66), end to end against the real rules: the real
 * remote classes, the real queries, `syncAll` on both sides. The in-memory
 * world in `../shareSync.test.ts` covers the cases in depth; this proves the
 * Firestore side agrees with it where it matters.
 */

describe('falling back while an index builds', () => {
  test('a missing index means the full read, once', async () => {
    let full = 0;
    const missing = Object.assign(new Error('needs an index'), { code: 'failed-precondition' });
    const result = await withIndexFallback(
      () => Promise.reject(missing),
      async () => {
        full += 1;
        return 'everything';
      },
    );
    expect(result).toBe('everything');
    expect(full).toBe(1);
  });

  test('any other failure is not hidden behind a second read', async () => {
    const denied = Object.assign(new Error('no'), { code: 'permission-denied' });
    await expect(withIndexFallback(() => Promise.reject(denied), async () => 'never')).rejects.toBe(denied);
    expect(isMissingIndex(denied)).toBe(false);
    expect(isMissingIndex(null)).toBe(false);
    expect(isMissingIndex('failed-precondition')).toBe(false);
  });
});

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const describeWithEmulator = describe.skipIf(HOST === undefined);

function allowedUidsInRules(): string[] {
  const source = readFileSync('firestore.rules', 'utf8');
  const block = /function allowed\(\)[\s\S]*?\[([\s\S]*?)\]/.exec(source);
  if (block === null) throw new Error('firestore.rules has no allowed() list');
  return [...block[1]!.matchAll(/'([^']*)'/g)].map((match) => match[1]!);
}

const [OWNER_UID, PARTNER_UID] = allowedUidsInRules();
const OWNER: Account = { uid: OWNER_UID!, name: 'Kyle', email: 'kyle@example.com', emailVerified: true };
const PARTNER: Account = { uid: PARTNER_UID!, name: 'Sam', email: 'sam@example.com', emailVerified: true };

describeWithEmulator('sharing through the real rules', () => {
  let env: RulesTestEnvironment;

  beforeAll(async () => {
    const [host, port] = (HOST ?? 'localhost:8080').split(':');
    env = await initializeTestEnvironment({
      projectId: 'fueltracker-sharing-e2e',
      firestore: { rules: readFileSync('firestore.rules', 'utf8'), host, port: Number(port) },
    });
  });

  beforeEach(async () => {
    await env.clearFirestore();
  });

  afterAll(async () => {
    await env?.cleanup();
  });

  function device(account: Account) {
    const db = env
      .authenticatedContext(account.uid, { email: account.email, email_verified: account.emailVerified })
      .firestore() as unknown as Firestore;
    const clock = new MonotonicClock();
    const store = new FuelTrackerStore(
      {
        vehicles: new InMemoryRepository<VehicleRecord>(),
        fillUps: new InMemoryRepository<FillUpRecord>(),
        pendingFillUps: new InMemoryRepository<PendingFillUpRecord>(),
      },
      clock,
      account.uid,
    );
    const states = new Map<string, InMemorySyncState>();
    const sharing: SharingSync = {
      remote: new FirestoreSharingRemote(db, account),
      stateFor: (key) => {
        const state = states.get(key) ?? new InMemorySyncState();
        states.set(key, state);
        return state;
      },
      forgetState: async (key) => {
        states.delete(key);
      },
      ledger: new InMemoryShareLedger(),
    };
    const ownState = new InMemorySyncState();
    const own = FirestoreRemoteStore.over(db, account.uid);
    return { store, sharing, sync: () => syncAll(store, own, sharing, clock, ownState) };
  }

  const draft = (odometer: number) => {
    const made = makeFuelEntryDraft({ date: new Date(2026, 0, 1), odometer, gallons: 10, pricePerGallon: 3.5 });
    if (made === null) throw new Error('fixture draft failed validation');
    return made;
  };

  test('invite, accept, both log, and the partner is removed', async () => {
    const owner = device(OWNER);
    const partner = device(PARTNER);

    const car = await owner.store.addVehicle({ name: 'Civic' });
    await owner.store.addFillUp(draft(10_000), car.id);
    const mine = await owner.store.addVehicle({ name: 'Private' });
    await owner.store.addFillUp(draft(50_000), mine.id);
    expect((await owner.sync()).own.ok).toBe(true);

    await owner.sharing.remote.invite(car, ' Sam@Example.com ');
    const [invitation] = await partner.sharing.remote.invitesForMe();
    expect(invitation?.vehicleName).toBe('Civic');
    await partner.sharing.remote.accept(invitation!);
    expect(await partner.sharing.remote.invitesForMe()).toHaveLength(0);

    // The partner's sync brings the shared car, and only it.
    const joined = await partner.sync();
    expect(joined.own.ok).toBe(true);
    expect(joined.shares.synced).toHaveLength(1);
    expect((await partner.store.vehicles()).map((v) => v.name)).toEqual(['Civic']);
    expect(await partner.store.fillUps(car.id)).toHaveLength(1);

    // The partner logs one; the owner sees it, entered by the partner.
    const theirs = await partner.store.addFillUp(draft(10_300), car.id);
    expect((await partner.sync()).shares.failed).toHaveLength(0);
    await owner.sync();
    expect((await owner.store.fillUp(theirs.id))?.enteredBy).toBe(PARTNER.uid);

    // And both can see who the car is shared with.
    expect((await owner.sharing.remote.members(OWNER.uid, car.id)).map((m) => m.name)).toEqual(['Sam']);
    expect((await partner.sharing.remote.members(OWNER.uid, car.id)).map((m) => m.uid)).toEqual([PARTNER.uid]);

    // Removed: the partner's next sync forgets the car, and pushes nothing.
    await owner.sharing.remote.removeMember(car.id, PARTNER.uid);
    const removed = await partner.sync();
    expect(removed.shares.ended).toHaveLength(1);
    expect(await partner.store.vehicles()).toHaveLength(0);
    await owner.sync();
    expect(await owner.store.fillUps(car.id)).toHaveLength(2);
    expect(await partner.sharing.remote.memberships()).toHaveLength(0);
  });

  test('a partner who leaves keeps nothing, and the owner keeps everything', async () => {
    const owner = device(OWNER);
    const partner = device(PARTNER);
    const car = await owner.store.addVehicle({ name: 'Civic' });
    await owner.store.addFillUp(draft(10_000), car.id);
    await owner.sync();
    await owner.sharing.remote.invite(car, 'sam@example.com');
    const [invitation] = await partner.sharing.remote.invitesForMe();
    const membership = await partner.sharing.remote.accept(invitation!);
    await partner.sync();

    await partner.sharing.remote.leave(membership);
    await partner.sync();

    expect(await partner.store.vehicles()).toHaveLength(0);
    await owner.sync();
    expect(await owner.store.fillUps(car.id)).toHaveLength(1);
  });

  test('declining uses up the invitation without joining', async () => {
    const owner = device(OWNER);
    const partner = device(PARTNER);
    const car = await owner.store.addVehicle({ name: 'Civic' });
    await owner.sync();
    await owner.sharing.remote.invite(car, 'sam@example.com');
    expect(await owner.sharing.remote.invitesSent()).toHaveLength(1);
    const [invitation] = await partner.sharing.remote.invitesForMe();
    await partner.sharing.remote.decline(invitation!);
    expect(await owner.sharing.remote.invitesSent()).toHaveLength(0);
    expect((await partner.sync()).shares.synced).toHaveLength(0);
    expect(await partner.store.vehicles()).toHaveLength(0);
  });
});
