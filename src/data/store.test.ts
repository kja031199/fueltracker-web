import { beforeEach, describe, expect, test } from 'vitest';
import { makeFuelEntryDraft } from '../domain/fuelEntryDraft';
import type { FuelEntryDraft } from '../domain/fuelEntryDraft';
import { computeFuelStatistics } from '../domain/fuelStatistics';
import { InMemoryRepository } from './repository';
import type { FillUpRecord, PendingFillUpRecord, VehicleRecord } from './records';
import { SCHEMA_VERSION } from './records';
import type { StoreClock } from './store';
import { FuelTrackerStore, toStats } from './store';

/** A clock that advances by a millisecond per read, so ids and times differ. */
function testClock(start = 1_000): StoreClock {
  let time = start;
  let counter = 0;
  return {
    now: () => (time += 1),
    newId: () => `id-${(counter += 1)}`,
  };
}

function makeStore(clock: StoreClock = testClock()): FuelTrackerStore {
  return new FuelTrackerStore(
    {
      vehicles: new InMemoryRepository<VehicleRecord>(),
      fillUps: new InMemoryRepository<FillUpRecord>(),
      pendingFillUps: new InMemoryRepository<PendingFillUpRecord>(),
    },
    clock,
  );
}

function draft(overrides: Partial<Parameters<typeof makeFuelEntryDraft>[0]> = {}): FuelEntryDraft {
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

let store: FuelTrackerStore;
beforeEach(() => {
  store = makeStore();
});

describe('vehicles', () => {
  test('adds a vehicle with the four sync fields', async () => {
    const vehicle = await store.addVehicle({ name: 'Daily Driver', make: 'Honda', year: 2021 });
    expect(vehicle.name).toBe('Daily Driver');
    expect(vehicle.deletedAt).toBeNull();
    expect(vehicle.schemaVersion).toBe(SCHEMA_VERSION);
    expect(vehicle.id).not.toBe('');
    expect(await store.vehicles()).toHaveLength(1);
  });

  test('defaults the optional fields rather than leaving them undefined', async () => {
    const vehicle = await store.addVehicle({ name: 'Bare' });
    expect(vehicle.make).toBe('');
    expect(vehicle.model).toBe('');
    expect(typeof vehicle.year).toBe('number');
  });

  test('lists vehicles oldest-created first', async () => {
    await store.addVehicle({ name: 'First' });
    await store.addVehicle({ name: 'Second' });
    expect((await store.vehicles()).map((v) => v.name)).toEqual(['First', 'Second']);
  });

  test('removing a vehicle also tombstones its fill-ups', async () => {
    // A tombstone cannot cascade on its own. Without this, the entries stay
    // live in storage — invisible in the UI, but ready to sync back as rows
    // belonging to a vehicle that no longer exists.
    const keep = await store.addVehicle({ name: 'Keep' });
    const drop = await store.addVehicle({ name: 'Drop' });
    await store.addFillUp(draft(), drop.id);
    await store.addFillUp(draft({ odometer: 10_400 }), drop.id);
    await store.addFillUp(draft({ odometer: 20_000 }), keep.id);

    await store.removeVehicle(drop.id);

    expect(await store.vehicles()).toHaveLength(1);
    expect(await store.fillUps(drop.id)).toHaveLength(0);
    expect(await store.fillUps(keep.id)).toHaveLength(1);
  });

  test('removing a vehicle with no fill-ups is fine', async () => {
    const vehicle = await store.addVehicle({ name: 'Empty' });
    await expect(store.removeVehicle(vehicle.id)).resolves.toBeUndefined();
    expect(await store.vehicles()).toHaveLength(0);
  });
});

describe('fill-ups go through the draft, and only through the draft', () => {
  test('a validated draft is written with its fields intact', async () => {
    const vehicle = await store.addVehicle({ name: 'Car' });
    const record = await store.addFillUp(
      draft({ station: 'Shell', notes: 'road trip', fuelGrade: 'Premium' }),
      vehicle.id,
    );
    expect(record.vehicleId).toBe(vehicle.id);
    expect(record.odometer).toBe(10_000);
    expect(record.station).toBe('Shell');
    expect(record.notes).toBe('road trip');
    expect(record.fuelGrade).toBe('Premium');
    expect(record.deletedAt).toBeNull();
  });

  test('an unvalidated entry cannot be constructed at all', async () => {
    // The gate is the type system rather than a review: `addFillUp` takes a
    // draft, and these inputs never produce one, so there is no value to pass.
    expect(makeFuelEntryDraft({ date: new Date(), odometer: 0, gallons: 10, pricePerGallon: 3 }))
      .toBeNull();
    expect(makeFuelEntryDraft({ date: new Date(), odometer: 100, gallons: -1, pricePerGallon: 3 }))
      .toBeNull();
    expect(makeFuelEntryDraft({
      date: new Date(),
      odometer: 100,
      gallons: 10,
      pricePerGallon: Number.POSITIVE_INFINITY,
    })).toBeNull();
  });

  test('the date is stored as epoch milliseconds and round-trips', async () => {
    const vehicle = await store.addVehicle({ name: 'Car' });
    const when = new Date(2025, 5, 15, 9, 30);
    const record = await store.addFillUp(draft({ date: when }), vehicle.id);
    expect(record.date).toBe(when.getTime());
    expect(new Date(record.date)).toEqual(when);
  });

  test('editing keeps the id and replaces the row', async () => {
    const vehicle = await store.addVehicle({ name: 'Car' });
    const created = await store.addFillUp(draft(), vehicle.id);
    const edited = await store.updateFillUp(
      created.id,
      draft({ gallons: 12, station: 'Costco' }),
      vehicle.id,
    );
    expect(edited.id).toBe(created.id);
    expect(await store.fillUps(vehicle.id)).toHaveLength(1);
    expect((await store.fillUps(vehicle.id))[0]?.gallons).toBe(12);
  });

  test('an oversized receipt is dropped while the fill-up still saves', async () => {
    // Losing the photo is recoverable; losing the fill-up is not.
    const vehicle = await store.addVehicle({ name: 'Car' });
    const huge = new Uint8Array(5 * 1024 * 1024);
    const record = await store.addFillUp(draft({ receiptImageData: huge }), vehicle.id);
    expect(record.receiptImageData).toBeNull();
    expect(await store.fillUps(vehicle.id)).toHaveLength(1);
  });

  test('lists one vehicle fill-ups newest first', async () => {
    const vehicle = await store.addVehicle({ name: 'Car' });
    const other = await store.addVehicle({ name: 'Other' });
    await store.addFillUp(draft({ date: new Date(2025, 0, 1) }), vehicle.id);
    await store.addFillUp(draft({ date: new Date(2025, 2, 1) }), vehicle.id);
    await store.addFillUp(draft({ date: new Date(2025, 1, 1) }), vehicle.id);
    await store.addFillUp(draft({ date: new Date(2025, 3, 1) }), other.id);

    const dates = (await store.fillUps(vehicle.id)).map((r) => new Date(r.date).getMonth());
    expect(dates).toEqual([2, 1, 0]);
  });

  test('removing a fill-up tombstones it', async () => {
    const vehicle = await store.addVehicle({ name: 'Car' });
    const record = await store.addFillUp(draft(), vehicle.id);
    await store.removeFillUp(record.id);
    expect(await store.fillUps(vehicle.id)).toHaveLength(0);
  });
});

describe('pending submissions', () => {
  test('submit then approve produces a real fill-up and clears the queue', async () => {
    const vehicle = await store.addVehicle({ name: 'Car' });
    const pending = await store.submitFillUp(draft({ station: 'Shell' }), vehicle.id, 'Sam');
    expect(await store.pendingFillUps()).toHaveLength(1);
    expect(pending.submitterName).toBe('Sam');

    const approved = await store.approvePendingFillUp(pending.id);
    expect(approved).not.toBeNull();
    expect(approved?.station).toBe('Shell');
    expect(approved?.vehicleId).toBe(vehicle.id);
    expect(await store.pendingFillUps()).toHaveLength(0);
    expect(await store.fillUps(vehicle.id)).toHaveLength(1);
  });

  test('approval re-validates rather than trusting the stored row', async () => {
    // The record has sat in storage in between, and once submissions arrive
    // over a link it will have come from outside. A queue that skipped this
    // check would be a way around the write gate.
    const vehicle = await store.addVehicle({ name: 'Car' });
    const repos = new InMemoryRepository<PendingFillUpRecord>();
    const scoped = new FuelTrackerStore(
      {
        vehicles: new InMemoryRepository<VehicleRecord>([
          { ...vehicle },
        ]),
        fillUps: new InMemoryRepository<FillUpRecord>(),
        pendingFillUps: repos,
      },
      testClock(),
    );
    await repos.put({
      id: 'corrupt',
      updatedAt: 1,
      deletedAt: null,
      schemaVersion: SCHEMA_VERSION,
      vehicleId: vehicle.id,
      submittedAt: 1,
      submitterName: 'Sam',
      date: Date.now(),
      odometer: 10_000,
      gallons: 0, // would poison every statistic
      pricePerGallon: 3.5,
      isFullTank: true,
      fuelGrade: 'Regular',
      station: '',
      notes: '',
      latitude: null,
      longitude: null,
      receiptImageData: null,
    });

    expect(await scoped.approvePendingFillUp('corrupt')).toBeNull();
    // ...and it stays in the queue rather than vanishing silently.
    expect(await scoped.pendingFillUps()).toHaveLength(1);
    expect(await scoped.fillUps(vehicle.id)).toHaveLength(0);
  });

  test('approving something absent returns null', async () => {
    expect(await store.approvePendingFillUp('nope')).toBeNull();
  });

  test('rejecting removes it without creating a fill-up', async () => {
    const vehicle = await store.addVehicle({ name: 'Car' });
    const pending = await store.submitFillUp(draft(), vehicle.id, 'Sam');
    await store.rejectPendingFillUp(pending.id);
    expect(await store.pendingFillUps()).toHaveLength(0);
    expect(await store.fillUps(vehicle.id)).toHaveLength(0);
  });

  test('lists submissions newest first', async () => {
    const vehicle = await store.addVehicle({ name: 'Car' });
    await store.submitFillUp(draft(), vehicle.id, 'First');
    await store.submitFillUp(draft(), vehicle.id, 'Second');
    expect((await store.pendingFillUps()).map((p) => p.submitterName))
      .toEqual(['Second', 'First']);
  });
});

describe('toStats bridges storage to the statistics layer', () => {
  test('stored rows compute the same MPG the domain layer expects', async () => {
    const vehicle = await store.addVehicle({ name: 'Car' });
    await store.addFillUp(draft({ date: new Date(2025, 0, 1), odometer: 10_000 }), vehicle.id);
    await store.addFillUp(draft({ date: new Date(2025, 0, 11), odometer: 10_400 }), vehicle.id);

    const stats = computeFuelStatistics(toStats(await store.fillUps(vehicle.id)));
    // 400 miles on the 10 gallons added since the baseline.
    expect(stats.mpgPoints).toHaveLength(1);
    expect(stats.averageMPG).toBeCloseTo(40, 6);
  });

  test('converts the stored epoch back into a Date', async () => {
    const vehicle = await store.addVehicle({ name: 'Car' });
    const when = new Date(2025, 4, 20, 8, 15);
    await store.addFillUp(draft({ date: when }), vehicle.id);
    const [entry] = toStats(await store.fillUps(vehicle.id));
    expect(entry?.date).toEqual(when);
  });

  test('an empty history produces empty statistics rather than throwing', async () => {
    const vehicle = await store.addVehicle({ name: 'Car' });
    const stats = computeFuelStatistics(toStats(await store.fillUps(vehicle.id)));
    expect(stats.mpgPoints).toHaveLength(0);
    expect(stats.averageMPG).toBeNull();
  });
});
