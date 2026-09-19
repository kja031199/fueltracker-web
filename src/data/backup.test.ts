import { describe, expect, test } from 'vitest';
import { computeFuelStatistics } from '../domain/fuelStatistics';
import { parseJsonBackup, toJsonBackup } from '../domain/backupFormat';
import { backupFilename, exportSnapshot, importBackup } from './backup';
import { InMemoryRepository } from './repository';
import type { FillUpRecord, PendingFillUpRecord, VehicleRecord } from './records';
import { FuelTrackerStore, toStats } from './store';
import type { Repositories } from './store';
import { makeFuelEntryDraft } from '../domain/fuelEntryDraft';
import { seedDemoData } from './demoData';

function makeRepos(): Repositories {
  return {
    vehicles: new InMemoryRepository<VehicleRecord>(),
    fillUps: new InMemoryRepository<FillUpRecord>(),
    pendingFillUps: new InMemoryRepository<PendingFillUpRecord>(),
  };
}

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

describe('exportSnapshot', () => {
  test('includes tombstones, so a deletion is not undone by a restore', async () => {
    // The reason this reads the repositories rather than the store's own
    // accessors: those return live rows only, and a backup built on them would
    // resurrect everything the reader had deleted.
    const repos = makeRepos();
    const store = new FuelTrackerStore(repos);
    const vehicle = await store.addVehicle({ name: 'Car' });
    const kept = await store.addFillUp(draft(), vehicle.id);
    const removed = await store.addFillUp(draft({ odometer: 10_400 }), vehicle.id);
    await store.removeFillUp(removed.id);

    const snapshot = await exportSnapshot(repos);
    expect(snapshot.fillUps).toHaveLength(2);
    expect(snapshot.fillUps.find((r) => r.id === kept.id)?.deletedAt).toBeNull();
    expect(snapshot.fillUps.find((r) => r.id === removed.id)?.deletedAt).not.toBeNull();
  });

  test('an empty store exports empty collections rather than failing', async () => {
    const snapshot = await exportSnapshot(makeRepos());
    expect(snapshot).toEqual({ vehicles: [], fillUps: [], pendingFillUps: [] });
  });
});

describe('the whole round trip', () => {
  test('a demo history survives export, wipe and import with identical stats', async () => {
    // The thing this phase exists for: a cleared browser must be recoverable.
    const source = makeRepos();
    const sourceStore = new FuelTrackerStore(source);
    const vehicleId = await seedDemoData(sourceStore, { now: new Date(2025, 5, 15) });
    const before = computeFuelStatistics(toStats(await sourceStore.fillUps(vehicleId)));

    const file = toJsonBackup(await exportSnapshot(source));

    // A brand-new, empty store — the "cleared browser data" case.
    const restored = makeRepos();
    const restoredStore = new FuelTrackerStore(restored);
    const parsed = parseJsonBackup(file);
    expect(parsed.error).toBeNull();
    const summary = await importBackup(restored, parsed.value!);

    expect(summary.vehiclesWritten).toBe(1);
    expect(summary.fillUpsWritten).toBe(12);
    expect(summary.rejected).toEqual([]);

    const after = computeFuelStatistics(toStats(await restoredStore.fillUps(vehicleId)));
    expect(after.averageMPG).toBe(before.averageMPG);
    expect(after.totalSpent).toBe(before.totalSpent);
    expect(after.mpgPoints).toHaveLength(before.mpgPoints.length);
  });

  test('importing the same file twice changes nothing the second time', async () => {
    // Last-write-wins makes a repeated import a no-op rather than a way to
    // duplicate an entire history.
    const source = makeRepos();
    await seedDemoData(new FuelTrackerStore(source), { now: new Date(2025, 5, 15) });
    const file = toJsonBackup(await exportSnapshot(source));

    const target = makeRepos();
    const first = await importBackup(target, parseJsonBackup(file).value!);
    const second = await importBackup(target, parseJsonBackup(file).value!);

    expect(first.fillUpsWritten).toBe(12);
    expect(second.fillUpsWritten).toBe(0);
    expect(second.skippedOlder).toBe(13); // twelve fill-ups and one vehicle
    expect(await target.fillUps.list()).toHaveLength(12);
  });
});

describe('merging, not replacing', () => {
  test('a newer local edit survives an older backup', async () => {
    // Restoring last week's backup must not destroy this morning's correction.
    const repos = makeRepos();
    const store = new FuelTrackerStore(repos);
    const vehicle = await store.addVehicle({ name: 'Car' });
    const record = await store.addFillUp(draft({ station: 'Costco' }), vehicle.id);

    const stale = {
      vehicles: [],
      pendingFillUps: [],
      fillUps: [{ ...record, station: 'Shell', updatedAt: record.updatedAt - 10_000 }],
    };
    const summary = await importBackup(repos, stale);

    expect(summary.fillUpsWritten).toBe(0);
    expect(summary.skippedOlder).toBe(1);
    expect((await repos.fillUps.get(record.id))?.station).toBe('Costco');
  });

  test('a newer backup row replaces the local one', async () => {
    const repos = makeRepos();
    const store = new FuelTrackerStore(repos);
    const vehicle = await store.addVehicle({ name: 'Car' });
    const record = await store.addFillUp(draft({ station: 'Costco' }), vehicle.id);

    await importBackup(repos, {
      vehicles: [],
      pendingFillUps: [],
      fillUps: [{ ...record, station: 'Shell', updatedAt: record.updatedAt + 10_000 }],
    });
    expect((await repos.fillUps.get(record.id))?.station).toBe('Shell');
  });

  test('rows the file does not mention are left alone', async () => {
    const repos = makeRepos();
    const store = new FuelTrackerStore(repos);
    const vehicle = await store.addVehicle({ name: 'Car' });
    await store.addFillUp(draft(), vehicle.id);

    await importBackup(repos, { vehicles: [], fillUps: [], pendingFillUps: [] });
    expect(await repos.fillUps.list()).toHaveLength(1);
    expect(await repos.vehicles.list()).toHaveLength(1);
  });

  test('a tombstone in the file deletes the local row rather than being ignored', async () => {
    const repos = makeRepos();
    const store = new FuelTrackerStore(repos);
    const vehicle = await store.addVehicle({ name: 'Car' });
    const record = await store.addFillUp(draft(), vehicle.id);

    await importBackup(repos, {
      vehicles: [],
      pendingFillUps: [],
      fillUps: [{ ...record, deletedAt: record.updatedAt + 1, updatedAt: record.updatedAt + 1 }],
    });
    expect(await repos.fillUps.get(record.id)).toBeUndefined();
    expect(await repos.fillUps.listDeleted()).toHaveLength(1);
  });
});

describe('the write gate applies to imported rows', () => {
  test('a fill-up with impossible numbers is rejected and counted', async () => {
    // An import file is a new input source and an untrusted one, so it builds
    // a draft like every other write path.
    const repos = makeRepos();
    const good = {
      id: 'good', updatedAt: 10, deletedAt: null, schemaVersion: 1, vehicleId: 'v1',
      date: Date.now(), odometer: 10_000, gallons: 10, pricePerGallon: 3.5,
      isFullTank: true, missedPreviousFillUp: false, fuelGrade: 'Regular' as const,
      station: '', notes: '', latitude: null, longitude: null, receiptImageData: null,
    };
    const summary = await importBackup(repos, {
      vehicles: [],
      pendingFillUps: [],
      fillUps: [
        good,
        { ...good, id: 'zero', gallons: 0 },
        { ...good, id: 'negative', odometer: -5 },
        { ...good, id: 'infinite', pricePerGallon: Number.POSITIVE_INFINITY },
      ],
    });

    // One bad row must not cost someone the rest of the file.
    expect(summary.fillUpsWritten).toBe(1);
    expect(summary.rejected).toHaveLength(3);
    expect(await repos.fillUps.list()).toHaveLength(1);
    expect(summary.rejected[0]).toMatch(/positive numbers/);
  });

  test('a tombstone is written without being validated', async () => {
    // It carries no usable measurements and does not need to — it is a record
    // that something was deleted, and validating it would reject it.
    const repos = makeRepos();
    const summary = await importBackup(repos, {
      vehicles: [],
      pendingFillUps: [],
      fillUps: [
        {
          id: 'gone', updatedAt: 10, deletedAt: 10, schemaVersion: 1, vehicleId: 'v1',
          date: 0, odometer: 0, gallons: 0, pricePerGallon: 0,
          isFullTank: true, missedPreviousFillUp: false, fuelGrade: 'Regular',
          station: '', notes: '', latitude: null, longitude: null, receiptImageData: null,
        },
      ],
    });
    expect(summary.rejected).toEqual([]);
    expect(await repos.fillUps.listDeleted()).toHaveLength(1);
  });
});

describe('backupFilename', () => {
  test('sorts by date and says what it is', () => {
    expect(backupFilename(new Date(2025, 5, 1))).toBe('fueltracker-2025-06-01.json');
    expect(backupFilename(new Date(2025, 11, 25), 'csv')).toBe('fueltracker-2025-12-25.csv');
  });
});
