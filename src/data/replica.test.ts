import { describe, expect, test } from 'vitest';
import { InMemoryRepository } from './repository';
import type { FillUpRecord, PendingFillUpRecord, VehicleRecord } from './records';
import { FuelTrackerStore } from './store';
import { Replica } from './replica';

/**
 * The store for the screens, and its replica for sync (#91).
 *
 * The store used to carry, beside the writes the screens make, everything only
 * sync should call: re-stamping, repairing, forgetting a shared car, reading
 * rows by id, merging with a tie-break. Now those are on `Replica`, which the
 * store holds and sync is handed — the store's own type has none of them.
 */

function makeStore(): FuelTrackerStore {
  return new FuelTrackerStore({
    vehicles: new InMemoryRepository<VehicleRecord>(),
    fillUps: new InMemoryRepository<FillUpRecord>(),
    pendingFillUps: new InMemoryRepository<PendingFillUpRecord>(),
  });
}

describe('what the screens can reach (#91)', () => {
  test('the store has none of sync’s operations', () => {
    const store = makeStore();
    const neverRun = (): void => {
      // @ts-expect-error — sync's alone
      void store.restamp('vehicles', []);
      // @ts-expect-error — sync's alone
      void store.repairOversizedTextIn({ vehicles: [], fillUps: [], pendingFillUps: [] });
      // @ts-expect-error — sync's alone
      void store.repairOversizedText();
      // @ts-expect-error — sync's alone
      void store.forgetVehicle('v');
      // @ts-expect-error — sync's alone
      void store.rowsById('vehicles', []);
      // @ts-expect-error — a merge with a tie-break is sync's; a file import has none
      void store.importBackup({ vehicles: [], fillUps: [], pendingFillUps: [] }, () => true);
    };
    expect(neverRun).toBeTypeOf('function');
    for (const name of ['restamp', 'repairOversizedTextIn', 'repairOversizedText', 'forgetVehicle', 'rowsById']) {
      expect(name in store, name).toBe(false);
    }
  });

  test('sync reaches them through the store’s replica, over the same rows and clock', async () => {
    const store = makeStore();
    expect(store.replica).toBeInstanceOf(Replica);
    expect(store.replica.clock).toBe(store.clock);
    const car = await store.addVehicle({ name: 'Civic' });
    expect((await store.replica.rowsById('vehicles', [car.id])).map((row) => row.id)).toEqual([car.id]);
    await store.replica.forgetVehicle(car.id);
    expect(await store.vehicles()).toEqual([]);
  });
});

describe('a file import is not sync’s merge (#91)', () => {
  test('importing the same file twice writes nothing the second time', async () => {
    const store = makeStore();
    await store.addVehicle({ name: 'Civic' });
    const file = await store.exportSnapshot();

    const again = await store.importBackup(file);

    expect(again.vehiclesWritten).toBe(0);
    expect(again.skippedOlder).toBe(1);
  });

  test('a row with the same stamp keeps what is here: a file has no tie-break', async () => {
    const store = makeStore();
    const car = await store.addVehicle({ name: 'Civic' });

    await store.importBackup({ vehicles: [{ ...car, name: 'Renamed in the file' }], fillUps: [], pendingFillUps: [] });

    expect((await store.vehicles())[0]?.name).toBe('Civic');
  });
});
