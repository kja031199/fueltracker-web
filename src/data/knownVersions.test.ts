import { describe, expect, test } from 'vitest';
import { makeStore } from '../test/fixtures';
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { FuelTrackerDatabase } from './db';
import { DexieSyncState } from './dexieState';
import { InMemoryRemoteStore } from './testing/inMemoryRemote';
import { SCHEMA_VERSION, type VehicleRecord } from './records';
import { syncOnce } from './sync';
import { InMemorySyncState, type KnownUpdate, type SyncCursor, type SyncStateStore } from './syncState';

/**
 * What this device knows the account holds, kept beside the cursor rather
 * than inside it (#91).
 *
 * The cursor used to carry every row's version, keyed `collection/id`, and
 * every sync rewrote all of it — for the account's own cursor and every shared
 * car's. Now the cursor holds its marks alone, and a sync writes only the
 * versions it read.
 */

const implementations: [string, () => Promise<SyncStateStore & { clear?: () => Promise<void> }>][] = [
  ['InMemorySyncState', async () => new InMemorySyncState()],
  [
    'DexieSyncState',
    async () => {
      const db = new FuelTrackerDatabase(`known-${crypto.randomUUID()}`);
      await db.open();
      return new DexieSyncState(db);
    },
  ],
];

describe.each(implementations)('%s keeps known versions', (_name, make) => {
  test('nothing at first', async () => {
    expect(await (await make()).loadKnown()).toEqual({});
  });

  test('what is set is kept, and set again replaces it', async () => {
    const state = await make();
    await state.saveKnown({ replace: [], set: { 'vehicles/v1': 1, 'fillUps/f1': 2 } });
    await state.saveKnown({ replace: [], set: { 'fillUps/f1': 3, 'fillUps/f2': 4 } });
    expect(await state.loadKnown()).toEqual({ 'vehicles/v1': 1, 'fillUps/f1': 3, 'fillUps/f2': 4 });
  });

  test('a collection read in full replaces that collection’s versions, and only that one', async () => {
    const state = await make();
    await state.saveKnown({ replace: [], set: { 'vehicles/v1': 1, 'fillUps/f1': 2, 'fillUps/gone': 9 } });
    await state.saveKnown({ replace: ['fillUps'], set: { 'fillUps/f1': 5 } });
    expect(await state.loadKnown()).toEqual({ 'vehicles/v1': 1, 'fillUps/f1': 5 });
  });

  test('ids that look like other keys are still only themselves', async () => {
    const state = await make();
    await state.saveKnown({ replace: [], set: { 'fillUps/a|b': 1, 'fillUps/vehicles/x': 2 } });
    await state.saveKnown({ replace: ['vehicles'], set: {} });
    expect(await state.loadKnown()).toEqual({ 'fillUps/a|b': 1, 'fillUps/vehicles/x': 2 });
  });
});

describe('DexieSyncState keeps each cursor’s versions apart', () => {
  test('the account’s and a shared car’s never mix, and clearing one leaves the other', async () => {
    const db = new FuelTrackerDatabase(`known-${crypto.randomUUID()}`);
    await db.open();
    const own = new DexieSyncState(db);
    const shared = new DexieSyncState(db, 'share:owner__car');
    await own.saveKnown({ replace: [], set: { 'fillUps/mine': 1 } });
    await shared.saveKnown({ replace: [], set: { 'fillUps/theirs': 2 } });
    await shared.save({
      version: 2,
      schemaVersion: SCHEMA_VERSION,
      highWater: { vehicles: null, fillUps: 1, pendingFillUps: null },
      fullPulledAt: 1,
    });

    expect(await own.loadKnown()).toEqual({ 'fillUps/mine': 1 });
    await shared.clear();
    expect(await shared.loadKnown()).toEqual({});
    expect(await shared.load()).toBeNull();
    expect(await own.loadKnown()).toEqual({ 'fillUps/mine': 1 });
  });

  test('a cursor key that is the start of another’s does not read or clear its versions', async () => {
    // A car id may hold `|`, so a separator a key can contain would make
    // `share:u__X` the prefix of `share:u__X|Y`.
    const db = new FuelTrackerDatabase(`known-${crypto.randomUUID()}`);
    await db.open();
    const short = new DexieSyncState(db, 'share:u__X');
    const long = new DexieSyncState(db, 'share:u__X|Y');
    await long.saveKnown({ replace: [], set: { 'fillUps/f': 1 } });

    expect(await short.loadKnown()).toEqual({});
    await short.saveKnown({ replace: ['fillUps'], set: {} });
    await short.clear();
    expect(await long.loadKnown()).toEqual({ 'fillUps/f': 1 });
  });
});

/** A state that records what a sync wrote. */
class Counting extends InMemorySyncState {
  readonly updates: KnownUpdate[] = [];
  readonly cursors: SyncCursor[] = [];

  override async saveKnown(update: KnownUpdate): Promise<void> {
    this.updates.push(update);
    return super.saveKnown(update);
  }

  override async save(cursor: SyncCursor): Promise<void> {
    this.cursors.push(cursor);
    return super.save(cursor);
  }
}

function vehicle(id: string, updatedAt: number): VehicleRecord {
  return { id, updatedAt, deletedAt: null, schemaVersion: SCHEMA_VERSION, name: id, make: '', model: '', year: 2020, createdAt: 1 };
}

describe('a sync writes only the versions it read (#91)', () => {
  test('a full read replaces all three; an incremental one adds what changed, and nothing else', async () => {
    const remote = new InMemoryRemoteStore();
    await remote.push({ vehicles: Array.from({ length: 50 }, (_, i) => vehicle(`v${i}`, 100 + i)), fillUps: [], pendingFillUps: [] });
    const store = makeStore();
    const state = new Counting();

    await syncOnce(store, remote, state);
    expect(state.updates[0]?.replace).toEqual(['vehicles', 'fillUps', 'pendingFillUps']);
    expect(Object.keys(state.updates[0]?.set ?? {})).toHaveLength(50);

    await remote.push({ vehicles: [vehicle('v7', 900)], fillUps: [], pendingFillUps: [] });
    await syncOnce(store, remote, state);

    expect(state.updates[1]).toEqual({ replace: [], set: { 'vehicles/v7': 900 } });
    // The cursor itself carries marks, not versions.
    for (const cursor of state.cursors) expect('known' in cursor).toBe(false);
  });

  test('versions that could not be read mean a full read, not a sync that knows nothing', async () => {
    const remote = new InMemoryRemoteStore();
    await remote.push({ vehicles: [vehicle('v1', 100)], fillUps: [], pendingFillUps: [] });
    const store = makeStore();
    const state = new Counting();
    await syncOnce(store, remote, state);

    state.loadKnown = () => Promise.reject(new Error('storage blocked'));
    await syncOnce(store, remote, state);

    expect(remote.pullLog.at(-1)?.since).toBeNull();
  });

  test('when the versions cannot be saved, the cursor is not moved past them', async () => {
    const remote = new InMemoryRemoteStore();
    await remote.push({ vehicles: [vehicle('v1', 100)], fillUps: [], pendingFillUps: [] });
    const store = makeStore();
    const state = new Counting();
    state.saveKnown = () => Promise.reject(new Error('quota'));

    const result = await syncOnce(store, remote, state);

    expect(result.ok).toBe(true);
    expect(state.cursors).toEqual([]);
  });
});

describe('upgrading the device’s database to hold them (#91)', () => {
  test('a version-3 database opens with its rows kept and an empty table for the versions', async () => {
    const name = `known-${crypto.randomUUID()}`;
    const old = new Dexie(name);
    old.version(3).stores({
      vehicles: 'id, deletedAt',
      fillUps: 'id, vehicleId, date, deletedAt',
      pendingFillUps: 'id, vehicleId, deletedAt',
      syncState: 'key',
    });
    await old.open();
    await old.table('vehicles').put(vehicle('v1', 1));
    old.close();

    const db = new FuelTrackerDatabase(name);
    await db.open();
    expect(await db.vehicles.count()).toBe(1);
    expect(await db.knownVersions.count()).toBe(0);
    expect(db.verno).toBe(4);
    db.close();
  });
});
