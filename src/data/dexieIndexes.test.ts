import { beforeEach, describe, expect, test } from 'vitest';
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { FuelTrackerDatabase } from './db';
import { DexieRepository } from './dexieRepository';
import { DexieSyncState } from './dexieState';
import type { FillUpRecord } from './records';
import { SCHEMA_VERSION } from './records';
import { SYNC_CURSOR_VERSION } from './syncState';

/**
 * The indexed reads against real IndexedDB semantics (#53).
 *
 * `countLive` leans on an IndexedDB rule worth testing rather than trusting:
 * a `null` key is left out of an index, so the `deletedAt` index holds only
 * tombstones, and live rows are the table's count minus that index's count —
 * neither of which reads a single row.
 */
let name: string;
beforeEach(() => {
  name = `test-${crypto.randomUUID()}`;
});

function row(id: string, vehicleId: string, deletedAt: number | null = null): FillUpRecord {
  return {
    id,
    updatedAt: 1,
    deletedAt,
    schemaVersion: SCHEMA_VERSION,
    vehicleId,
    date: 1_700_000_000_000,
    odometer: 10_000,
    gallons: 10,
    pricePerGallon: 3,
    isFullTank: true,
    missedPreviousFillUp: false,
    fuelGrade: 'Regular',
    station: '',
    notes: '',
    latitude: null,
    longitude: null,
    receiptImageData: null,
  };
}

describe('DexieRepository', () => {
  test("listForVehicle returns that vehicle's live rows only", async () => {
    const db = new FuelTrackerDatabase(name);
    await db.open();
    const repo = new DexieRepository(db.fillUps);
    await repo.put(row('a1', 'a'));
    await repo.put(row('a2', 'a', 5));
    await repo.put(row('b1', 'b'));

    expect((await repo.listForVehicle('a')).map((r) => r.id)).toEqual(['a1']);
    expect(await repo.listForVehicle('nobody')).toEqual([]);
    db.close();
  });

  test('countLive counts live rows, with tombstones present', async () => {
    const db = new FuelTrackerDatabase(name);
    await db.open();
    const repo = new DexieRepository(db.fillUps);
    expect(await repo.countLive()).toBe(0);
    await repo.put(row('a1', 'a'));
    await repo.put(row('a2', 'a', 5));
    await repo.put(row('b1', 'b'));
    await repo.put(row('b2', 'b', 0)); // a tombstone at the epoch is still a tombstone

    expect(await repo.countLive()).toBe(2);
    db.close();
  });

  test('countLive is zero for a table of nothing but deletions', async () => {
    const db = new FuelTrackerDatabase(name);
    await db.open();
    const repo = new DexieRepository(db.fillUps);
    await repo.put(row('a1', 'a', 5));
    expect(await repo.countLive()).toBe(0);
    db.close();
  });
});

describe('the version 3 upgrade', () => {
  test('keeps every row and the sync cursor', async () => {
    // Adding an index must not cost anybody their fuel log, or their place in
    // the sync — losing the cursor would only cost a full read, but losing it
    // silently would hide an upgrade that did more than it should.
    const old = new Dexie(name);
    old.version(1).stores({ vehicles: 'id', fillUps: 'id, vehicleId, date', pendingFillUps: 'id, vehicleId' });
    old.version(2).stores({
      vehicles: 'id',
      fillUps: 'id, vehicleId, date',
      pendingFillUps: 'id, vehicleId',
      syncState: 'key',
    });
    await old.open();
    await old.table('fillUps').bulkPut([row('a1', 'a'), row('a2', 'a', 5)]);
    const cursor = {
      version: SYNC_CURSOR_VERSION,
      schemaVersion: SCHEMA_VERSION,
      highWater: { vehicles: 1, fillUps: 2, pendingFillUps: null },
      known: { 'fillUps/a1': 1 },
      fullPulledAt: 10,
    };
    await old.table('syncState').put({ key: 'cursor', cursor });
    old.close();

    const db = new FuelTrackerDatabase(name);
    await db.open();
    const repo = new DexieRepository(db.fillUps);

    expect(await db.fillUps.count()).toBe(2);
    expect(await repo.countLive()).toBe(1);
    // The cursor survives the upgrade; only its old `known` field is not
    // read back (#91), and a version-1 cursor is discarded by sync anyway.
    const { known: _known, ...withoutKnown } = cursor;
    expect(await new DexieSyncState(db).load()).toEqual(withoutKnown);
    db.close();
  });
});
