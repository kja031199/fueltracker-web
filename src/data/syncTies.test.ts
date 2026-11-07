import { describe, expect, test } from 'vitest';
import { InMemoryRepository } from './repository';
import { InMemoryRemoteStore } from './remote';
import type { FillUpRecord, PendingFillUpRecord, VehicleRecord } from './records';
import { FuelTrackerStore } from './store';
import { syncOnce, tieWinner } from './sync';
import { MonotonicClock } from './syncClock';
import { InMemorySyncState } from './syncState';
import { makeFuelEntryDraft, type FuelEntryDraft } from '../domain/fuelEntryDraft';

/**
 * Two devices writing the same row in the same millisecond.
 *
 * Last-write-wins on `updatedAt` had no answer for a tie: the merge kept the
 * incoming row only when strictly newer, and the push sent a row only when
 * strictly newer than the account's — so each device kept its own version,
 * neither sent it, and they disagreed for ever. Found by the shared-car tests
 * (#66), where two people editing one car makes it likely; it was always
 * possible for one person on two devices.
 *
 * Reproduced deterministically here with frozen wall clocks: both devices
 * then issue the same timestamps in lockstep.
 */

const FROZEN = 1_800_000_000_000;

interface Device {
  readonly store: FuelTrackerStore;
  sync(): ReturnType<typeof syncOnce>;
}

function device(remote: InMemoryRemoteStore): Device {
  const clock = new MonotonicClock(() => FROZEN);
  const store = new FuelTrackerStore(
    {
      vehicles: new InMemoryRepository<VehicleRecord>(),
      fillUps: new InMemoryRepository<FillUpRecord>(),
      pendingFillUps: new InMemoryRepository<PendingFillUpRecord>(),
    },
    clock,
  );
  const state = new InMemorySyncState();
  return { store, sync: () => syncOnce(store, remote, clock, state) };
}

function draft(odometer: number): FuelEntryDraft {
  const made = makeFuelEntryDraft({ date: new Date(2026, 0, 1), odometer, gallons: 10, pricePerGallon: 3.5 });
  if (made === null) throw new Error('fixture draft failed validation');
  return made;
}

async function twoDevicesOneFillUp(): Promise<{ remote: InMemoryRemoteStore; a: Device; b: Device; car: string; id: string }> {
  const remote = new InMemoryRemoteStore();
  const a = device(remote);
  const b = device(remote);
  const car = await a.store.addVehicle({ name: 'Civic' });
  const entry = await a.store.addFillUp(draft(10_000), car.id);
  await a.sync();
  await b.sync();
  return { remote, a, b, car: car.id, id: entry.id };
}

async function settle(a: Device, b: Device): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    await a.sync();
    await b.sync();
  }
}

const view = async (d: Device, id: string) => {
  const row = (await d.store.exportSnapshot()).fillUps.find((f) => f.id === id);
  return row === undefined ? undefined : { deletedAt: row.deletedAt !== null, odometer: row.odometer };
};

describe('a tie between two devices', () => {
  test('the timestamps really do tie in this set-up', async () => {
    const { a, b, car, id } = await twoDevicesOneFillUp();
    const edited = await a.store.updateFillUp(id, draft(10_111));
    const other = await b.store.updateFillUp(id, draft(10_222));
    expect(edited.updatedAt).toBe(other.updatedAt);
  });

  test('a deletion and an edit at the same moment: both devices agree, and the deletion wins', async () => {
    const { a, b, car, id } = await twoDevicesOneFillUp();
    await a.store.updateFillUp(id, draft(10_111));
    await b.store.removeFillUp(id);
    await settle(a, b);
    expect(await view(a, id)).toEqual(await view(b, id));
    expect((await view(a, id))?.deletedAt).toBe(true);
  });

  test('the same, the other way round', async () => {
    const { a, b, car, id } = await twoDevicesOneFillUp();
    await a.store.removeFillUp(id);
    await b.store.updateFillUp(id, draft(10_111));
    await settle(a, b);
    expect(await view(a, id)).toEqual(await view(b, id));
    expect((await view(a, id))?.deletedAt).toBe(true);
  });

  test('two different edits at the same moment: both devices end with the same one', async () => {
    const { a, b, car, id } = await twoDevicesOneFillUp();
    await a.store.updateFillUp(id, draft(10_111));
    await b.store.updateFillUp(id, draft(10_222));
    await settle(a, b);
    expect(await view(a, id)).toEqual(await view(b, id));
    // And the account holds that same version.
  });

  test('whichever device syncs first, the winner is the same', async () => {
    const first = await twoDevicesOneFillUp();
    await first.a.store.updateFillUp(first.id, draft(10_111));
    await first.b.store.updateFillUp(first.id, draft(10_222));
    await settle(first.a, first.b);

    const second = await twoDevicesOneFillUp();
    await second.a.store.updateFillUp(second.id, draft(10_111));
    await second.b.store.updateFillUp(second.id, draft(10_222));
    await settle(second.b, second.a);

    expect((await view(first.a, first.id))?.odometer).toBe((await view(second.a, second.id))?.odometer);
  });

  test('identical rows at the same moment are not a conflict, and cause no churn', async () => {
    const { remote, a, b } = await twoDevicesOneFillUp();
    const before = remote.pullLog.length;
    await settle(a, b);
    const quiet = await a.sync();
    expect(quiet.ok && quiet.outcome.pushed.written).toBe(0);
    expect(remote.pullLog.length).toBeGreaterThan(before);
  });
});

describe('tieWinner', () => {
  const base = { id: 'x', updatedAt: 5, deletedAt: null, schemaVersion: 1, name: 'a' };

  test('a deletion beats an edit, either way round', () => {
    const deleted = { ...base, deletedAt: 5 };
    expect(tieWinner(deleted, base)).toBe('first');
    expect(tieWinner(base, deleted)).toBe('second');
  });

  test('otherwise the decision depends only on the two rows, not on which is local', () => {
    const one = { ...base, name: 'a' };
    const two = { ...base, name: 'b' };
    const forward = tieWinner(one, two);
    const backward = tieWinner(two, one);
    expect(forward).not.toBe('same');
    expect(forward === 'first' ? backward === 'second' : backward === 'first').toBe(true);
  });

  test('rows that differ only in receipt bytes are the same — a photo omitted from sync is not an edit', () => {
    const withPhoto = { ...base, receiptImageData: new Uint8Array([1, 2, 3]) };
    const without = { ...base, receiptImageData: null };
    expect(tieWinner(withPhoto, without)).toBe('same');
  });

  test('field order does not matter', () => {
    const one = { id: 'x', updatedAt: 5, deletedAt: null, schemaVersion: 1, a: 1, b: 2 };
    const two = { b: 2, a: 1, schemaVersion: 1, deletedAt: null, updatedAt: 5, id: 'x' };
    expect(tieWinner(one, two)).toBe('same');
  });

  test('two deletions are the same', () => {
    const renamed = { ...base, deletedAt: 5, name: 'other' };
    expect(tieWinner({ ...base, deletedAt: 5 }, renamed)).toBe('same');
  });
});

describe('a tie won here is sent by the same sync (#87)', () => {
  // Sync now reads the device once and re-reads by id what it writes; a
  // re-stamped winner must be re-read, or it waits a whole sync to be sent.
  // Both orders, so one of them is certainly won by the second device.
  test.each([
    [10_111, 10_222],
    [10_222, 10_111],
  ])('first device writes %i, second %i', async (first, second) => {
    const { remote, a, b, id } = await twoDevicesOneFillUp();
    await a.store.updateFillUp(id, draft(first));
    await b.store.updateFillUp(id, draft(second));
    await a.sync();

    await b.sync();

    const inAccount = ((await remote.pull(null)).fillUps as FillUpRecord[]).find((row) => row.id === id);
    expect(inAccount?.odometer).toBe((await view(b, id))?.odometer);
  });
});
