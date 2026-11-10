import { describe, expect, test } from 'vitest';
import { draftWith, makeStore } from '../test/fixtures';
import { InMemoryRepository } from './repository';
import type { FillUpRecord, PendingFillUpRecord, SyncFields, VehicleRecord } from './records';
import { FuelTrackerStore } from './store';

const draft = draftWith({ pricePerGallon: 3 });

/**
 * Local reads read only what they need (#53).
 *
 * Every query used to list a whole table and filter in memory: one vehicle's
 * fill-ups read every vehicle's, the count read every row to return a number,
 * and each of those deserialised every receipt photo. After every save the app
 * did both. This counts what the store actually asks storage for.
 */
class CountingRepository<T extends SyncFields & { readonly vehicleId?: string }> extends InMemoryRepository<T> {
  wholeTableReads = 0;
  readonly vehicleReads: string[] = [];

  override async list(): Promise<T[]> {
    this.wholeTableReads += 1;
    return super.list();
  }

  override async listForVehicle(vehicleId: string): Promise<T[]> {
    this.vehicleReads.push(vehicleId);
    return super.listForVehicle(vehicleId);
  }
}

const PHOTO = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

async function twoVehicles() {
  const fillUps = new CountingRepository<FillUpRecord>();
  const store = new FuelTrackerStore({
    vehicles: new InMemoryRepository<VehicleRecord>(),
    fillUps,
    pendingFillUps: new CountingRepository<PendingFillUpRecord>(),
  });
  const a = await store.addVehicle({ name: 'A' });
  const b = await store.addVehicle({ name: 'B' });
  const withPhoto = await store.addFillUp(draft({ receiptImageData: PHOTO }), a.id);
  await store.addFillUp(draft({ odometer: 10_300, date: new Date(2026, 0, 8) }), a.id);
  await store.addFillUp(draft(), b.id);
  fillUps.wholeTableReads = 0;
  fillUps.vehicleReads.length = 0;
  return { store, fillUps, a, b, withPhoto };
}

describe("one vehicle's fill-ups", () => {
  test("reads only that vehicle's rows, never the whole table", async () => {
    const { store, fillUps, a } = await twoVehicles();

    const rows = await store.fillUps(a.id);

    expect(rows).toHaveLength(2);
    expect(fillUps.vehicleReads).toEqual([a.id]);
    expect(fillUps.wholeTableReads).toBe(0);
  });

  test('are still newest first', async () => {
    const { store, a } = await twoVehicles();
    const rows = await store.fillUps(a.id);
    expect(rows.map((row) => row.odometer)).toEqual([10_300, 10_000]);
  });

  test('an unknown vehicle has none, and costs no whole-table read', async () => {
    const { store, fillUps } = await twoVehicles();
    expect(await store.fillUps('no-such-vehicle')).toEqual([]);
    expect(fillUps.wholeTableReads).toBe(0);
  });

  test('carry no photo bytes, only whether there is one', async () => {
    // The list keeps these in React state for the whole session; the photos
    // are only ever needed when one fill-up is opened for editing.
    const { store, a, withPhoto } = await twoVehicles();
    const rows = await store.fillUps(a.id);

    for (const row of rows) expect(row).not.toHaveProperty('receiptImageData');
    expect(rows.find((row) => row.id === withPhoto.id)?.hasReceipt).toBe(true);
    expect(rows.find((row) => row.id !== withPhoto.id)?.hasReceipt).toBe(false);
  });
});

describe('one whole fill-up, for editing', () => {
  test('comes with its photo', async () => {
    const { store, withPhoto } = await twoVehicles();
    expect((await store.fillUp(withPhoto.id))?.receiptImageData).toEqual(PHOTO);
  });

  test('a deleted or unknown one is absent', async () => {
    const { store, withPhoto } = await twoVehicles();
    await store.removeFillUp(withPhoto.id);
    expect(await store.fillUp(withPhoto.id)).toBeUndefined();
    expect(await store.fillUp('no-such-id')).toBeUndefined();
  });
});

describe('counting fill-ups', () => {
  test('never reads the whole table', async () => {
    const { store, fillUps } = await twoVehicles();
    expect(await store.fillUpCount()).toBe(3);
    expect(fillUps.wholeTableReads).toBe(0);
  });

  test('leaves deleted ones out', async () => {
    const { store, withPhoto } = await twoVehicles();
    await store.removeFillUp(withPhoto.id);
    expect(await store.fillUpCount()).toBe(2);
  });

  test('an empty log, and a log of nothing but deletions, both count zero', async () => {
    const store = makeStore();
    expect(await store.fillUpCount()).toBe(0);
    const car = await store.addVehicle({ name: 'Car' });
    const row = await store.addFillUp(draft(), car.id);
    await store.removeFillUp(row.id);
    expect(await store.fillUpCount()).toBe(0);
  });
});

describe('removing a vehicle', () => {
  test("reads only that vehicle's fill-ups, and leaves the others alone", async () => {
    const { store, fillUps, a, b } = await twoVehicles();

    await store.removeVehicle(a.id);

    expect(fillUps.vehicleReads).toEqual([a.id]);
    expect(fillUps.wholeTableReads).toBe(0);
    expect(await store.fillUps(a.id)).toEqual([]);
    expect(await store.fillUps(b.id)).toHaveLength(1);
  });
});
