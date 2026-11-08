import { beforeEach, describe, expect, test } from 'vitest';
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { FuelTrackerDatabase } from './db';
import { DexieSyncState } from './dexieState';
import { openAccountStore } from './accountStore';
import { SCHEMA_VERSION } from './records';
import { SYNC_CURSOR_VERSION, parseCursor, type SyncCursor } from './syncState';

/**
 * Where incremental sync keeps its place (#52).
 *
 * In the account's own IndexedDB database, deliberately: the cursor says "this
 * device already holds everything up to here", which is only true while the
 * rows it describes are still on disk. Kept anywhere that outlives them —
 * `localStorage`, say, which can be cleared separately — a cleared database
 * would be followed by an incremental read that never fetches the old rows.
 */
const CURSOR: SyncCursor = {
  version: SYNC_CURSOR_VERSION,
  schemaVersion: SCHEMA_VERSION,
  highWater: { vehicles: 10, fillUps: 20, pendingFillUps: null },
  known: { 'vehicles/v1': 100, 'fillUps/f1': 200 },
  fullPulledAt: 1_000,
};

let prefix: string;
beforeEach(() => {
  prefix = `test-${crypto.randomUUID()}`;
});

describe('DexieSyncState', () => {
  test('round-trips a cursor', async () => {
    const db = new FuelTrackerDatabase(`${prefix}-a`);
    await db.open();
    const state = new DexieSyncState(db);

    await state.save(CURSOR);

    expect(await state.load()).toEqual(CURSOR);
    db.close();
  });

  test('has no cursor in a fresh database, which means a full read', async () => {
    const db = new FuelTrackerDatabase(`${prefix}-b`);
    await db.open();
    expect(await new DexieSyncState(db).load()).toBeNull();
    db.close();
  });

  test('each account keeps its own cursor', async () => {
    const alice = await openAccountStore('uid-alice', prefix);
    const bob = await openAccountStore('uid-bob', prefix);
    await alice.syncState.save(CURSOR);

    expect(await bob.syncState.load()).toBeNull();
    alice.close();
    bob.close();
  });

  test('upgrading a version-1 database keeps every row', async () => {
    // The cursor needs a new table, so the schema version moves. Adding a table
    // must not cost anybody their fuel log.
    const name = `${prefix}-legacy`;
    const old = new Dexie(name);
    old.version(1).stores({ vehicles: 'id', fillUps: 'id, vehicleId, date', pendingFillUps: 'id, vehicleId' });
    await old.open();
    await old.table('vehicles').put({ id: 'v1', name: 'Kept' });
    old.close();

    const db = new FuelTrackerDatabase(name);
    await db.open();

    expect(await db.vehicles.get('v1')).toMatchObject({ name: 'Kept' });
    expect(await new DexieSyncState(db).load()).toBeNull();
    db.close();
  });
});

describe('parseCursor', () => {
  test('accepts a well-formed cursor', () => {
    expect(parseCursor(CURSOR)).toEqual(CURSOR);
  });

  test.each([
    ['nothing', undefined],
    ['null', null],
    ['a string', 'cursor'],
    ['no version', { ...CURSOR, version: undefined }],
    ['a non-finite high-water mark', { ...CURSOR, highWater: { ...CURSOR.highWater, fillUps: Number.NaN } }],
    ['a missing collection', { ...CURSOR, highWater: { vehicles: 1, fillUps: 2 } }],
    ['a non-number known version', { ...CURSOR, known: { 'vehicles/v1': '100' } }],
    ['known as an array', { ...CURSOR, known: [1, 2] }],
    ['a non-finite fullPulledAt', { ...CURSOR, fullPulledAt: Number.POSITIVE_INFINITY }],
  ])('treats %s as no cursor, which means a full read', (_label, value) => {
    // A damaged cursor costs one full read. Trusting it could cost rows.
    expect(parseCursor(value)).toBeNull();
  });
});
