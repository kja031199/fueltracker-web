import { beforeEach, describe, expect, test } from 'vitest';
import { draftWith } from '../test/fixtures';
// Before Dexie: it captures the IndexedDB global when the module loads.
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { LEGACY_DATABASE_NAME, databaseNameFor, openAccountStore, openSignedInAccount } from './accountStore';
import { FuelTrackerDatabase } from './db';
import { DexieRepository } from './dexieRepository';
import { FuelTrackerStore } from './store';

const draft = draftWith({ date: new Date(2025, 0, 15) });

/**
 * Storage has to be separated by account, and this file exists because it was
 * not.
 *
 * The bug: the app opened one IndexedDB database called `fueltracker`, for
 * everyone, created at module load before anything was known about the user.
 * The *remote* store was correctly per-uid; the local one was not, and nothing
 * cleared it on sign-out. So on a shared computer, person A signing out and
 * person B signing in gave B a store that still held A's rows — and the first
 * sync then pushed A's fill-ups **into B's account**, where they propagated to
 * B's other devices.
 *
 * The first test below is the one that reproduces it. It fails against a single
 * shared database and passes only when the database name carries the uid.
 */

/** A unique prefix per test, so tests cannot see each other's databases. */
let prefix: string;

beforeEach(() => {
  prefix = `test-${crypto.randomUUID()}`;
});

describe('separating one device’s accounts', () => {
  test('one person’s fill-ups never appear in another person’s store', async () => {
    const alice = await openAccountStore('uid-alice', prefix);
    const vehicle = await alice.store.addVehicle({ name: 'Civic' });
    await alice.store.addFillUp(draft(), vehicle.id);
    alice.close();

    // Same device, same browser, different Google account.
    const bob = await openAccountStore('uid-bob', prefix);

    expect(await bob.store.vehicles()).toEqual([]);
    // The snapshot is what sync pushes. If Alice's rows were in here, they
    // would be written into Bob's Firestore tree on his very first sync.
    const outgoing = await bob.store.exportSnapshot();
    expect(outgoing.fillUps).toEqual([]);
    expect(outgoing.vehicles).toEqual([]);
    bob.close();
  });

  test('signing back in finds your own data still there', async () => {
    // The reason the fix names databases per account rather than clearing on
    // sign-out: clearing would destroy local edits made before someone signed
    // out and before a sync could carry them up.
    const first = await openAccountStore('uid-alice', prefix);
    const vehicle = await first.store.addVehicle({ name: 'Civic' });
    await first.store.addFillUp(draft(), vehicle.id);
    first.close();

    const again = await openAccountStore('uid-alice', prefix);
    expect(await again.store.vehicles()).toHaveLength(1);
    expect(await again.store.fillUps(vehicle.id)).toHaveLength(1);
    again.close();
  });

  test('the database name carries the uid', () => {
    expect(databaseNameFor('uid-alice')).not.toBe(databaseNameFor('uid-bob'));
    expect(databaseNameFor('uid-alice')).toContain('uid-alice');
  });

  test('a uid that would be awkward in a name still gets its own database', () => {
    // Firebase uids are alphanumeric, but a name built by concatenation should
    // not be the thing standing between two accounts. Distinct uids must map
    // to distinct names even when one is a prefix of the other.
    expect(databaseNameFor('abc')).not.toBe(databaseNameFor('abcd'));
    expect(databaseNameFor('a')).not.toBe(databaseNameFor(''));
  });
});

describe('the pre-account database is left alone (#44)', () => {
  /**
   * The rescue that used to live here copied the old shared `fueltracker`
   * database into whichever account signed in first, then deleted it — on
   * sign-in, before any sync, so before anybody knew whether that account was
   * allowed. A refused stranger got the owner's rows, and since #41 the
   * no-access screen offered to export them.
   *
   * These tests sign in at the storage layer, where every account looks the
   * same: refusal is only learned later, when Firestore answers. That is the
   * point. Nothing that runs on sign-in may move data into an account, because
   * nothing that runs on sign-in knows who that account is allowed to be.
   */

  const legacyName = (): string => `${prefix}-${LEGACY_DATABASE_NAME}`;

  /** Writes rows into a legacy-named database, as the pre-accounts build did. */
  async function seedLegacy(): Promise<void> {
    const db = new FuelTrackerDatabase(legacyName());
    await db.open();
    const store = new FuelTrackerStore({
      vehicles: new DexieRepository(db.vehicles),
      fillUps: new DexieRepository(db.fillUps),
      pendingFillUps: new DexieRepository(db.pendingFillUps),
    });
    const vehicle = await store.addVehicle({ name: 'Owner’s Car' });
    await store.addFillUp(draft(), vehicle.id);
    db.close();
  }

  /** Reads the legacy database back, or null if it is gone. */
  async function legacyRows(): Promise<{ vehicles: number; fillUps: number } | null> {
    if (!(await Dexie.exists(legacyName()))) return null;
    const db = new FuelTrackerDatabase(legacyName());
    await db.open();
    const counts = { vehicles: await db.vehicles.count(), fillUps: await db.fillUps.count() };
    db.close();
    return counts;
  }

  test('an account signing in gets none of the legacy rows', async () => {
    // Acceptance (a). Whoever this is — the owner, or a stranger about to be
    // refused — their store starts holding only what they write themselves.
    await seedLegacy();

    const stranger = await openSignedInAccount('uid-stranger', prefix);
    const snapshot = await stranger.store.exportSnapshot();
    stranger.close();

    expect(snapshot.vehicles).toEqual([]);
    expect(snapshot.fillUps).toEqual([]);
    expect(snapshot.pendingFillUps).toEqual([]);
  });

  test('the legacy database is still there afterwards, rows intact', async () => {
    // Acceptance (b). Deleting it was the other half of the harm: the owner's
    // only local copy ended up living under the stranger's uid.
    await seedLegacy();

    const account = await openSignedInAccount('uid-stranger', prefix);
    account.close();

    expect(await legacyRows()).toEqual({ vehicles: 1, fillUps: 1 });
  });

  test('a second account on the same device gets nothing either', async () => {
    await seedLegacy();

    (await openSignedInAccount('uid-alice', prefix)).close();
    const bob = await openSignedInAccount('uid-bob', prefix);
    const vehicles = await bob.store.vehicles();
    bob.close();

    expect(vehicles).toEqual([]);
    expect(await legacyRows()).toEqual({ vehicles: 1, fillUps: 1 });
  });

  test('signing in does not create a legacy database where there was none', async () => {
    // Opening a Dexie database creates it. A sign-in path that so much as
    // opened the legacy name would leave one behind on every device.
    const account = await openSignedInAccount('uid-alice', prefix);
    account.close();

    expect(await Dexie.exists(legacyName())).toBe(false);
  });

  test('the account opens its own database, and only that', async () => {
    const account = await openSignedInAccount('uid-alice', prefix);
    account.close();

    expect(account.databaseName).toBe(databaseNameFor('uid-alice', prefix));
    expect(await Dexie.exists(databaseNameFor('uid-alice', prefix))).toBe(true);
  });
});
