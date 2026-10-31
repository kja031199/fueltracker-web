import { beforeEach, describe, expect, test } from 'vitest';
import 'fake-indexeddb/auto';
import { makeFuelEntryDraft } from '../domain/fuelEntryDraft';
import {
  LEGACY_DATABASE_NAME,
  adoptLegacyDatabase,
  databaseNameFor,
  openAccountStore,
} from './accountStore';
import { DexieRepository, FuelTrackerDatabase } from './db';
import { FuelTrackerStore } from './store';

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

function draft(overrides: Partial<Parameters<typeof makeFuelEntryDraft>[0]> = {}) {
  const result = makeFuelEntryDraft({
    date: new Date(2025, 0, 15),
    odometer: 10_000,
    gallons: 10,
    pricePerGallon: 3.5,
    ...overrides,
  });
  if (result === null) throw new Error('fixture draft failed validation');
  return result;
}

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

describe('adopting the pre-account database', () => {
  /** Writes rows into a legacy-named database, as the old build would have. */
  async function seedLegacy(name: string): Promise<string> {
    const db = new FuelTrackerDatabase(name);
    await db.open();
    const store = new FuelTrackerStore({
      vehicles: new DexieRepository(db.vehicles),
      fillUps: new DexieRepository(db.fillUps),
      pendingFillUps: new DexieRepository(db.pendingFillUps),
    });
    const vehicle = await store.addVehicle({ name: 'Legacy Car' });
    await store.addFillUp(draft(), vehicle.id);
    db.close();
    return vehicle.id;
  }

  test('existing data moves to the first account that signs in', async () => {
    // Not a nicety: the owner's real fill-ups are in the unscoped database
    // right now. Scoping the name without moving them would look exactly like
    // data loss.
    const legacy = `${prefix}-${LEGACY_DATABASE_NAME}`;
    await seedLegacy(legacy);

    const result = await adoptLegacyDatabase('uid-alice', prefix);

    expect(result.adopted).toBe(true);
    expect(result.vehicles).toBe(1);
    expect(result.fillUps).toBe(1);

    const alice = await openAccountStore('uid-alice', prefix);
    expect(await alice.store.vehicles()).toHaveLength(1);
    alice.close();
  });

  test('running it twice adopts nothing the second time', async () => {
    const legacy = `${prefix}-${LEGACY_DATABASE_NAME}`;
    await seedLegacy(legacy);

    await adoptLegacyDatabase('uid-alice', prefix);
    const second = await adoptLegacyDatabase('uid-alice', prefix);

    expect(second.adopted).toBe(false);
    const alice = await openAccountStore('uid-alice', prefix);
    // Not doubled.
    expect(await alice.store.vehicles()).toHaveLength(1);
    alice.close();
  });

  test('a second account on the same device does not inherit the first one’s data', async () => {
    // The adoption is a one-time rescue of the owner's own data, not a rule
    // that whoever signs in gets whatever was lying around. Once it has been
    // claimed it must never apply again.
    const legacy = `${prefix}-${LEGACY_DATABASE_NAME}`;
    await seedLegacy(legacy);

    await adoptLegacyDatabase('uid-alice', prefix);
    const forBob = await adoptLegacyDatabase('uid-bob', prefix);

    expect(forBob.adopted).toBe(false);
    const bob = await openAccountStore('uid-bob', prefix);
    expect(await bob.store.vehicles()).toEqual([]);
    bob.close();
  });

  test('refuses to overwrite an account that already has data', async () => {
    const legacy = `${prefix}-${LEGACY_DATABASE_NAME}`;
    await seedLegacy(legacy);

    const alice = await openAccountStore('uid-alice', prefix);
    const own = await alice.store.addVehicle({ name: 'Already Mine' });
    alice.close();

    const result = await adoptLegacyDatabase('uid-alice', prefix);

    expect(result.adopted).toBe(false);
    const again = await openAccountStore('uid-alice', prefix);
    const vehicles = await again.store.vehicles();
    expect(vehicles).toHaveLength(1);
    expect(vehicles[0]?.id).toBe(own.id);
    again.close();
  });

  test('no legacy database is the ordinary case, not an error', async () => {
    const result = await adoptLegacyDatabase('uid-alice', prefix);
    expect(result.adopted).toBe(false);
    expect(result.vehicles).toBe(0);
  });

  test('an empty legacy database is nothing to adopt', async () => {
    const db = new FuelTrackerDatabase(`${prefix}-${LEGACY_DATABASE_NAME}`);
    await db.open();
    db.close();

    const result = await adoptLegacyDatabase('uid-alice', prefix);
    expect(result.adopted).toBe(false);
  });

  test('tombstones come across too', async () => {
    // A deletion is a fact that has to survive the move. Dropping tombstones
    // would resurrect deleted fill-ups on the next sync, because the account
    // would have no record that they were ever removed.
    const legacy = `${prefix}-${LEGACY_DATABASE_NAME}`;
    const vehicleId = await seedLegacy(legacy);

    const db = new FuelTrackerDatabase(legacy);
    await db.open();
    const store = new FuelTrackerStore({
      vehicles: new DexieRepository(db.vehicles),
      fillUps: new DexieRepository(db.fillUps),
      pendingFillUps: new DexieRepository(db.pendingFillUps),
    });
    const extra = await store.addFillUp(draft({ odometer: 10_300 }), vehicleId);
    await store.removeFillUp(extra.id);
    db.close();

    await adoptLegacyDatabase('uid-alice', prefix);

    const alice = await openAccountStore('uid-alice', prefix);
    const snapshot = await alice.store.exportSnapshot();
    expect(snapshot.fillUps.filter((row) => row.deletedAt !== null)).toHaveLength(1);
    alice.close();
  });
});
