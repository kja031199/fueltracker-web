import { describe, expect, test } from 'vitest';
import { InMemoryRepository } from './repository';
import type { FillUpRecord, PendingFillUpRecord, VehicleRecord } from './records';
import { FuelTrackerStore } from './store';
import { makeFuelEntryDraft, type FuelEntryDraft } from '../domain/fuelEntryDraft';

/**
 * Receiving a submission from a link (#3) and reviewing it.
 */

function makeStore(): FuelTrackerStore {
  return new FuelTrackerStore(
    {
      vehicles: new InMemoryRepository<VehicleRecord>(),
      fillUps: new InMemoryRepository<FillUpRecord>(),
      pendingFillUps: new InMemoryRepository<PendingFillUpRecord>(),
    },
    undefined,
    'owner',
  );
}

function draft(odometer = 10_000): FuelEntryDraft {
  const made = makeFuelEntryDraft({ date: new Date(2026, 0, 1), odometer, gallons: 10, pricePerGallon: 3.5, station: 'Shell', notes: 'note' });
  if (made === null) throw new Error('fixture draft failed validation');
  return made;
}

describe('receiving a submission', () => {
  test('queues it under the id the link carried, with who sent it and when', async () => {
    const store = makeStore();
    const car = await store.addVehicle({ name: 'Civic' });
    const result = await store.receiveSubmission({ id: 'sub-1', vehicleId: car.id, submitterName: 'Sam', submittedAt: 123, draft: draft() });
    expect(result).toBe('queued');
    const [pending] = await store.pendingFillUps();
    expect(pending).toMatchObject({ id: 'sub-1', vehicleId: car.id, submitterName: 'Sam', submittedAt: 123, odometer: 10_000 });
    expect(await store.fillUpCount()).toBe(0);
  });

  test('the same link twice queues it once', async () => {
    const store = makeStore();
    const car = await store.addVehicle({ name: 'Civic' });
    const submission = { id: 'sub-1', vehicleId: car.id, submitterName: 'Sam', submittedAt: 1, draft: draft() };
    await store.receiveSubmission(submission);
    expect(await store.receiveSubmission({ ...submission, draft: draft(99_999) })).toBe('duplicate');
    expect(await store.pendingFillUps()).toHaveLength(1);
    expect((await store.pendingFillUps())[0]?.odometer).toBe(10_000);
  });

  test('a link already approved or rejected is not queued again', async () => {
    const store = makeStore();
    const car = await store.addVehicle({ name: 'Civic' });
    const one = { id: 'sub-1', vehicleId: car.id, submitterName: 'Sam', submittedAt: 1, draft: draft() };
    const two = { ...one, id: 'sub-2' };
    await store.receiveSubmission(one);
    await store.receiveSubmission(two);
    await store.approvePendingFillUp('sub-1');
    await store.rejectPendingFillUp('sub-2');
    expect(await store.receiveSubmission(one)).toBe('duplicate');
    expect(await store.receiveSubmission(two)).toBe('duplicate');
    expect(await store.pendingFillUps()).toHaveLength(0);
    expect(await store.fillUpCount()).toBe(1);
  });

  test('a car that is not here — never was, or was deleted — is refused', async () => {
    const store = makeStore();
    const car = await store.addVehicle({ name: 'Civic' });
    await store.removeVehicle(car.id);
    const base = { id: 'sub-1', submitterName: 'Sam', submittedAt: 1, draft: draft() };
    expect(await store.receiveSubmission({ ...base, vehicleId: car.id })).toBe('no-such-car');
    expect(await store.receiveSubmission({ ...base, vehicleId: 'never' })).toBe('no-such-car');
    expect(await store.pendingFillUps()).toHaveLength(0);
  });

  test('the submitter’s name is bounded like any text from outside', async () => {
    const store = makeStore();
    const car = await store.addVehicle({ name: 'Civic' });
    await store.receiveSubmission({ id: 's', vehicleId: car.id, submitterName: 'x'.repeat(5000), submittedAt: 1, draft: draft() });
    expect((await store.pendingFillUps())[0]?.submitterName.length).toBeLessThanOrEqual(200);
  });
});

describe('approving', () => {
  test('makes a fill-up entered by the owner who approved it, and clears the queue', async () => {
    const store = makeStore();
    const car = await store.addVehicle({ name: 'Civic' });
    await store.receiveSubmission({ id: 'sub-1', vehicleId: car.id, submitterName: 'Sam', submittedAt: 1, draft: draft() });
    const made = await store.approvePendingFillUp('sub-1');
    expect(made?.odometer).toBe(10_000);
    expect(made?.station).toBe('Shell');
    expect(made?.enteredBy).toBe('owner');
    expect(await store.pendingFillUps()).toHaveLength(0);
  });

  test('is refused once the car has been deleted, and the submission stays to be dealt with', async () => {
    const store = makeStore();
    const car = await store.addVehicle({ name: 'Civic' });
    await store.receiveSubmission({ id: 'sub-1', vehicleId: car.id, submitterName: 'Sam', submittedAt: 1, draft: draft() });
    await store.removeVehicle(car.id);
    expect(await store.approvePendingFillUp('sub-1')).toBeNull();
    expect(await store.fillUpCount()).toBe(0);
  });

  test('an unknown submission is nothing to approve', async () => {
    expect(await makeStore().approvePendingFillUp('nope')).toBeNull();
  });
});
