import 'fake-indexeddb/auto';
import { describe, expect, test } from 'vitest';
import { InMemoryRepository } from './repository';
import { DexieRepository, FuelTrackerDatabase } from './db';
import type { FillUpRecord, PendingFillUpRecord, VehicleRecord } from './records';
import { FuelTrackerStore, type Repositories } from './store';
import { validateFillUp } from './recordValidation';
import { tombstoneFillUp } from './tombstone';
import { makeFuelEntryDraft, type FuelEntryDraft } from '../domain/fuelEntryDraft';

/**
 * The store's part in sharing a car (#66): who entered a fill-up, and
 * forgetting a car this device only held because it was shared.
 */

function memory(): Repositories {
  return {
    vehicles: new InMemoryRepository<VehicleRecord>(),
    fillUps: new InMemoryRepository<FillUpRecord>(),
    pendingFillUps: new InMemoryRepository<PendingFillUpRecord>(),
  };
}

function dexie(): Repositories {
  const db = new FuelTrackerDatabase(`sharing-${crypto.randomUUID()}`);
  return {
    vehicles: new DexieRepository<VehicleRecord>(db.vehicles),
    fillUps: new DexieRepository<FillUpRecord>(db.fillUps),
    pendingFillUps: new DexieRepository<PendingFillUpRecord>(db.pendingFillUps),
  };
}

function draft(odometer = 10_000): FuelEntryDraft {
  const made = makeFuelEntryDraft({ date: new Date(2026, 0, 1), odometer, gallons: 10, pricePerGallon: 3.5 });
  if (made === null) throw new Error('fixture draft failed validation');
  return made;
}

describe.each([
  ['in memory', memory],
  ['Dexie', dexie],
])('%s', (_name, repos) => {
  describe('who entered a fill-up', () => {
    test('a new fill-up is stamped with the signed-in account', async () => {
      const store = new FuelTrackerStore(repos(), undefined, 'me');
      const vehicle = await store.addVehicle({ name: 'Civic' });
      const entry = await store.addFillUp(draft(), vehicle.id);
      expect(entry.enteredBy).toBe('me');
      expect((await store.fillUp(entry.id))?.enteredBy).toBe('me');
    });

    test('an edit keeps who entered it, whoever edits', async () => {
      const shared = repos();
      const owner = new FuelTrackerStore(shared, undefined, 'owner');
      const vehicle = await owner.addVehicle({ name: 'Civic' });
      const entry = await owner.addFillUp(draft(), vehicle.id);

      const partner = new FuelTrackerStore(shared, undefined, 'partner');
      const edited = await partner.updateFillUp(entry.id, draft(12_000), vehicle.id);
      expect(edited.odometer).toBe(12_000);
      expect(edited.enteredBy).toBe('owner');
    });

    test('with no account, nobody is named', async () => {
      const store = new FuelTrackerStore(repos());
      const vehicle = await store.addVehicle({ name: 'Civic' });
      expect((await store.addFillUp(draft(), vehicle.id)).enteredBy).toBeNull();
    });

    test('a deleted fill-up keeps who entered it, so a member may delete it (the rules compare)', async () => {
      const store = new FuelTrackerStore(repos(), undefined, 'partner');
      const vehicle = await store.addVehicle({ name: 'Civic' });
      const entry = await store.addFillUp(draft(), vehicle.id);
      await store.removeFillUp(entry.id);
      const snapshot = await store.exportSnapshot();
      const tombstone = snapshot.fillUps.find((row) => row.id === entry.id);
      expect(tombstone?.deletedAt).not.toBeNull();
      expect(tombstone?.enteredBy).toBe('partner');
      // And nothing else of the row survives.
      expect(tombstone?.station).toBe('');
    });
  });

  describe('forgetting a shared car', () => {
    test('removes the car and every row of it — live and deleted — and nothing else', async () => {
      const store = new FuelTrackerStore(repos(), undefined, 'me');
      const shared = await store.addVehicle({ name: 'Shared' });
      const mine = await store.addVehicle({ name: 'Mine' });
      const a = await store.addFillUp(draft(10_000), shared.id);
      await store.addFillUp(draft(10_300), shared.id);
      await store.removeFillUp(a.id); // a tombstone, which must go too
      const kept = await store.addFillUp(draft(5_000), mine.id);

      await store.forgetVehicle(shared.id);

      const snapshot = await store.exportSnapshot();
      expect(snapshot.vehicles.map((v) => v.id)).toEqual([mine.id]);
      expect(snapshot.fillUps.map((f) => f.id)).toEqual([kept.id]);
    });

    test('leaves no tombstone behind, so nothing about it is ever pushed', async () => {
      // The rows were never this account's to delete: a tombstone would try to
      // sync a deletion of the owner's car into the owner's account.
      const store = new FuelTrackerStore(repos(), undefined, 'me');
      const shared = await store.addVehicle({ name: 'Shared' });
      await store.addFillUp(draft(), shared.id);
      await store.forgetVehicle(shared.id);
      const snapshot = await store.exportSnapshot();
      expect(snapshot.vehicles).toHaveLength(0);
      expect(snapshot.fillUps).toHaveLength(0);
      expect(await store.fillUpCount()).toBe(0);
    });

    test('an unknown car is nothing to forget', async () => {
      const store = new FuelTrackerStore(repos());
      const vehicle = await store.addVehicle({ name: 'Mine' });
      await expect(store.forgetVehicle('no-such-car')).resolves.toBeUndefined();
      expect((await store.vehicles()).map((v) => v.id)).toEqual([vehicle.id]);
    });
  });
});

describe('enteredBy from the account', () => {
  const base = {
    id: 'f1', updatedAt: 1, deletedAt: null, schemaVersion: 1, vehicleId: 'v1', date: 1_700_000_000_000,
    odometer: 10_000, gallons: 10, pricePerGallon: 3, isFullTank: true, missedPreviousFillUp: false,
    fuelGrade: 'Regular', station: '', notes: '', latitude: null, longitude: null, receiptImageData: null,
  };

  test('is kept when it is a plausible uid', () => {
    const row = validateFillUp({ ...base, enteredBy: 'uid-123' });
    expect(typeof row === 'string' ? row : row.enteredBy).toBe('uid-123');
  });

  test.each([
    ['absent (an older build)', undefined],
    ['null', null],
    ['empty', ''],
    ['a number', 42],
    ['an object', { uid: 'x' }],
    ['longer than any uid', 'u'.repeat(129)],
  ])('reads as nobody when it is %s — never as a reason to drop the fill-up', (_label, enteredBy) => {
    const input = enteredBy === undefined ? base : { ...base, enteredBy };
    const row = validateFillUp(input);
    expect(typeof row).not.toBe('string');
    expect(typeof row === 'string' ? row : row.enteredBy).toBeNull();
  });

  test('a tombstone built from a row without it stays without it', () => {
    const { ...row } = base as unknown as FillUpRecord;
    expect(tombstoneFillUp(row, 5).enteredBy ?? null).toBeNull();
  });
});
