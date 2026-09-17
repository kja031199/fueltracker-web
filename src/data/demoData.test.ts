import { describe, expect, test } from 'vitest';
import { computeFuelStatistics } from '../domain/fuelStatistics';
import { InMemoryRepository } from './repository';
import type { FillUpRecord, PendingFillUpRecord, VehicleRecord } from './records';
import { FuelTrackerStore, toStats } from './store';
import { seedDemoData } from './demoData';

const ANCHOR = new Date(2025, 5, 15);

function makeStore(): FuelTrackerStore {
  return new FuelTrackerStore({
    vehicles: new InMemoryRepository<VehicleRecord>(),
    fillUps: new InMemoryRepository<FillUpRecord>(),
    pendingFillUps: new InMemoryRepository<PendingFillUpRecord>(),
  });
}

describe('seedDemoData', () => {
  test('creates one vehicle and twelve fill-ups', async () => {
    const store = makeStore();
    const vehicleId = await seedDemoData(store, { now: ANCHOR });

    const vehicles = await store.vehicles();
    expect(vehicles).toHaveLength(1);
    expect(vehicles[0]?.name).toBe('Daily Driver');
    expect(vehicles[0]?.id).toBe(vehicleId);
    expect(await store.fillUps(vehicleId)).toHaveLength(12);
  });

  test('is deterministic, unlike the Swift original', async () => {
    // Upstream calls Double.random, so every preview differs. Fine for
    // eyeballing a layout; wrong for a demo that should look the same on every
    // visit, and wrong for a fixture, where it turns a regression into a flake.
    const first = makeStore();
    const second = makeStore();
    const a = await seedDemoData(first, { now: ANCHOR });
    const b = await seedDemoData(second, { now: ANCHOR });

    const shape = (records: Awaited<ReturnType<FuelTrackerStore['fillUps']>>) =>
      records.map((r) => [r.date, r.odometer, r.gallons, r.pricePerGallon, r.station]);

    expect(shape(await first.fillUps(a))).toEqual(shape(await second.fillUps(b)));
  });

  test('a different seed gives a different but equally stable history', async () => {
    const store = makeStore();
    const vehicleId = await seedDemoData(store, { now: ANCHOR, seed: 7 });
    const gallons = (await store.fillUps(vehicleId)).map((r) => r.gallons);

    const again = makeStore();
    const againId = await seedDemoData(again, { now: ANCHOR, seed: 7 });
    expect((await again.fillUps(againId)).map((r) => r.gallons)).toEqual(gallons);

    const other = makeStore();
    const otherId = await seedDemoData(other, { now: ANCHOR, seed: 8 });
    expect((await other.fillUps(otherId)).map((r) => r.gallons)).not.toEqual(gallons);
  });

  test('looks like a real car rather than an arithmetic series', async () => {
    const store = makeStore();
    const vehicleId = await seedDemoData(store, { now: ANCHOR });
    const stats = computeFuelStatistics(toStats(await store.fillUps(vehicleId)));

    // Eleven segments from twelve full tanks — the first is the baseline.
    expect(stats.mpgPoints).toHaveLength(11);
    expect(stats.averageMPG).toBeGreaterThan(28);
    expect(stats.averageMPG).toBeLessThan(38);
    // Nothing in a plausible history should trip the unlogged-fill detector.
    expect(stats.suspectSegmentIds.size).toBe(0);
    // And the numbers must not all be identical.
    expect(new Set(stats.mpgPoints.map((p) => p.mpg)).size).toBeGreaterThan(5);
  });

  test('spans roughly six months, ending near the anchor', async () => {
    const store = makeStore();
    const vehicleId = await seedDemoData(store, { now: ANCHOR });
    const records = await store.fillUps(vehicleId); // newest first
    const newest = records[0]!.date;
    const oldest = records[records.length - 1]!.date;

    const days = (newest - oldest) / 86_400_000;
    expect(days).toBeCloseTo(165, 0); // eleven gaps of fifteen days
    expect(newest).toBeLessThanOrEqual(ANCHOR.getTime());
  });

  test('the odometer only ever moves forward', async () => {
    const store = makeStore();
    const vehicleId = await seedDemoData(store, { now: ANCHOR });
    const records = [...(await store.fillUps(vehicleId))].reverse(); // oldest first
    for (let i = 1; i < records.length; i += 1) {
      expect(records[i]!.odometer).toBeGreaterThan(records[i - 1]!.odometer);
    }
  });

  test('every seeded row is a valid stored record', async () => {
    // Demo data is data: it goes through the same draft gate and carries the
    // same sync fields as anything a user types.
    const store = makeStore();
    const vehicleId = await seedDemoData(store, { now: ANCHOR });
    for (const record of await store.fillUps(vehicleId)) {
      expect(record.gallons).toBeGreaterThan(0);
      expect(record.pricePerGallon).toBeGreaterThan(0);
      expect(record.odometer).toBeGreaterThan(0);
      expect(record.deletedAt).toBeNull();
      expect(record.vehicleId).toBe(vehicleId);
      expect(record.isFullTank).toBe(true);
    }
  });

  test('seeding twice produces two independent vehicles', async () => {
    const store = makeStore();
    const first = await seedDemoData(store, { now: ANCHOR });
    const second = await seedDemoData(store, { now: ANCHOR });
    expect(first).not.toBe(second);
    expect(await store.vehicles()).toHaveLength(2);
    expect(await store.fillUps(first)).toHaveLength(12);
    expect(await store.fillUps(second)).toHaveLength(12);
  });
});
