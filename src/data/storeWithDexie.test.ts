import { describe, expect, test } from 'vitest';
import { draftWith, submitted } from '../test/fixtures';
import 'fake-indexeddb/auto';
import { computeFuelStatistics } from '../domain/fuelStatistics';
import { FuelTrackerDatabase } from './db';
import { DexieRepository } from './dexieRepository';
import { FuelTrackerStore } from './store';
import { toStats } from './records';
import { seedDemoData } from '../test/demoData';

const draft = draftWith({ date: new Date(2025, 0, 15) });

/**
 * The store over the real storage engine.
 *
 * `store.test.ts` runs against the in-memory repository because it is testing
 * store logic and wants determinism. This file runs the same store over Dexie,
 * because a few things can only go wrong at the IndexedDB boundary — binary
 * receipt data, and whether anything survives a reload at all — and neither is
 * visible from a Map.
 */
async function openStore(): Promise<{ store: FuelTrackerStore; db: FuelTrackerDatabase }> {
  const db = new FuelTrackerDatabase(`integration-${crypto.randomUUID()}`);
  await db.open();
  const store = new FuelTrackerStore({
    vehicles: new DexieRepository(db.vehicles),
    fillUps: new DexieRepository(db.fillUps),
    pendingFillUps: new DexieRepository(db.pendingFillUps),
  });
  return { store, db };
}

describe('the store over IndexedDB', () => {
  test('a full add-and-read cycle works against real storage', async () => {
    const { store, db } = await openStore();
    const vehicle = await store.addVehicle({ name: 'Daily Driver', make: 'Honda', year: 2021 });
    await store.addFillUp(draft({ station: 'Shell' }), vehicle.id);

    const records = await store.fillUps(vehicle.id);
    expect(records).toHaveLength(1);
    expect(records[0]?.station).toBe('Shell');
    db.close();
  });

  test('receipt bytes survive the round trip intact', async () => {
    // The one thing a Map cannot tell you: IndexedDB stores a typed array by
    // structured clone, and a byte that changes on the way back out would
    // corrupt every stored receipt silently.
    const { store, db } = await openStore();
    const vehicle = await store.addVehicle({ name: 'Car' });
    const bytes = new Uint8Array([0, 1, 127, 128, 255, 42]);
    const added = await store.addFillUp(draft({ receiptImageData: bytes }), vehicle.id);

    // The whole row: list rows carry no photo bytes since #53.
    const stored = (await store.fillUp(added.id))?.receiptImageData;
    expect(stored).not.toBeNull();
    expect(Array.from(stored!)).toEqual([0, 1, 127, 128, 255, 42]);
    db.close();
  });

  test('data survives closing and reopening the database', async () => {
    const name = `integration-${crypto.randomUUID()}`;
    const first = new FuelTrackerDatabase(name);
    await first.open();
    const firstStore = new FuelTrackerStore({
      vehicles: new DexieRepository(first.vehicles),
      fillUps: new DexieRepository(first.fillUps),
      pendingFillUps: new DexieRepository(first.pendingFillUps),
    });
    const vehicleId = await seedDemoData(firstStore, { now: new Date(2025, 5, 15) });
    first.close();

    const second = new FuelTrackerDatabase(name);
    await second.open();
    const secondStore = new FuelTrackerStore({
      vehicles: new DexieRepository(second.vehicles),
      fillUps: new DexieRepository(second.fillUps),
      pendingFillUps: new DexieRepository(second.pendingFillUps),
    });

    expect(await secondStore.vehicles()).toHaveLength(1);
    const records = await secondStore.fillUps(vehicleId);
    expect(records).toHaveLength(12);

    // And the statistics layer reads the reloaded rows unchanged.
    const stats = computeFuelStatistics(toStats(records));
    expect(stats.mpgPoints).toHaveLength(11);
    second.close();
  });

  test('a tombstoned fill-up stays out of the list after a reopen', async () => {
    // A soft delete that did not persist would resurrect the row on reload —
    // the exact failure tombstones exist to prevent.
    const name = `integration-${crypto.randomUUID()}`;
    const first = new FuelTrackerDatabase(name);
    await first.open();
    const firstStore = new FuelTrackerStore({
      vehicles: new DexieRepository(first.vehicles),
      fillUps: new DexieRepository(first.fillUps),
      pendingFillUps: new DexieRepository(first.pendingFillUps),
    });
    const vehicle = await firstStore.addVehicle({ name: 'Car' });
    const record = await firstStore.addFillUp(draft(), vehicle.id);
    await firstStore.removeFillUp(record.id);
    first.close();

    const second = new FuelTrackerDatabase(name);
    await second.open();
    const reopened = new DexieRepository(second.fillUps);
    expect(await reopened.list()).toHaveLength(0);
    expect(await reopened.listDeleted()).toHaveLength(1);
    second.close();
  });

  test('submit and approve works end to end on real storage', async () => {
    const { store, db } = await openStore();
    const vehicle = await store.addVehicle({ name: 'Car' });
    const pending = await submitted(store, draft(), vehicle.id, 'Sam');
    const approved = await store.approvePendingFillUp(pending.id);

    expect(approved).not.toBeNull();
    expect(await store.pendingFillUps()).toHaveLength(0);
    expect(await store.fillUps(vehicle.id)).toHaveLength(1);
    db.close();
  });
});

describe('the reads sync relies on, over IndexedDB (#87)', () => {
  async function seeded() {
    const { store, db } = await openStore();
    const a = await store.addVehicle({ name: 'A' });
    const b = await store.addVehicle({ name: 'B' });
    const live = await store.addFillUp(draft(), a.id);
    const deleted = await store.addFillUp(draft({ odometer: 10_100 }), a.id);
    await store.removeFillUp(deleted.id);
    const other = await store.addFillUp(draft(), b.id);
    const repo = new DexieRepository(db.fillUps);
    return { store, db, repo, a, b, live, deleted, other };
  }

  test('listAll is every row, live and deleted, in one read', async () => {
    const { repo, live, deleted, other } = await seeded();
    expect((await repo.listAll()).map((row) => row.id).sort()).toEqual([live.id, deleted.id, other.id].sort());
  });

  test('listDeleted, from the index, is the tombstones and never a live row', async () => {
    const { repo, deleted } = await seeded();
    expect((await repo.listDeleted()).map((row) => row.id)).toEqual([deleted.id]);
  });

  test('getMany finds live and deleted rows by id, skips unknown ids and repeats', async () => {
    const { repo, live, deleted } = await seeded();
    const rows = await repo.getMany([live.id, deleted.id, 'never', live.id]);
    expect(rows.map((row) => row.id).sort()).toEqual([live.id, deleted.id].sort());
    expect(await repo.getMany([])).toEqual([]);
  });

  test("listForVehicleAll is one car's rows, deleted included, and only that car's", async () => {
    const { repo, a, b, live, deleted, other } = await seeded();
    expect((await repo.listForVehicleAll(a.id)).map((row) => row.id).sort()).toEqual([live.id, deleted.id].sort());
    expect((await repo.listForVehicleAll(b.id)).map((row) => row.id)).toEqual([other.id]);
    expect(await repo.listForVehicleAll('never')).toEqual([]);
  });

  test('a snapshot round-trips the same rows as before, receipts and tombstones included', async () => {
    const { store, a } = await seeded();
    const photo = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9]);
    const withPhoto = await store.addFillUp(draft({ receiptImageData: photo }), a.id);
    const snapshot = await store.exportSnapshot();
    expect(snapshot.fillUps).toHaveLength(4);
    expect(snapshot.fillUps.filter((row) => row.deletedAt !== null)).toHaveLength(1);
    expect(Array.from(snapshot.fillUps.find((row) => row.id === withPhoto.id)?.receiptImageData ?? [])).toEqual(
      Array.from(photo),
    );
  });
});
