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

// --- Broader cases -------------------------------------------------------------

describe('forgetting, more widely', () => {
  test('takes the car’s submissions with it, and leaves other cars’ alone', async () => {
    const store = new FuelTrackerStore(memory(), undefined, 'me');
    const shared = await store.addVehicle({ name: 'Shared' });
    const mine = await store.addVehicle({ name: 'Mine' });
    await store.submitFillUp(draft(), shared.id, 'Neighbour');
    const kept = await store.submitFillUp(draft(), mine.id, 'Neighbour');
    await store.forgetVehicle(shared.id);
    expect((await store.pendingFillUps()).map((p) => p.id)).toEqual([kept.id]);
  });

  test('a car that was already deleted is forgotten too, tombstone and all', async () => {
    const store = new FuelTrackerStore(memory(), undefined, 'me');
    const shared = await store.addVehicle({ name: 'Shared' });
    await store.addFillUp(draft(), shared.id);
    await store.removeVehicle(shared.id);
    await store.forgetVehicle(shared.id);
    const snapshot = await store.exportSnapshot();
    expect(snapshot.vehicles).toHaveLength(0);
    expect(snapshot.fillUps).toHaveLength(0);
  });

  test('forgetting twice is harmless', async () => {
    const store = new FuelTrackerStore(memory(), undefined, 'me');
    const shared = await store.addVehicle({ name: 'Shared' });
    await store.forgetVehicle(shared.id);
    await expect(store.forgetVehicle(shared.id)).resolves.toBeUndefined();
  });

  test('a car with many fill-ups is forgotten completely', async () => {
    const store = new FuelTrackerStore(memory(), undefined, 'me');
    const shared = await store.addVehicle({ name: 'Shared' });
    for (let i = 0; i < 200; i += 1) await store.addFillUp(draft(10_000 + i * 300), shared.id);
    await store.forgetVehicle(shared.id);
    expect(await store.fillUpCount()).toBe(0);
  });
});

describe('re-stamping a row that won a tie', () => {
  test('moves only updatedAt, live or deleted', async () => {
    const store = new FuelTrackerStore(memory(), undefined, 'me');
    const car = await store.addVehicle({ name: 'Civic' });
    const live = await store.addFillUp(draft(10_000), car.id);
    const gone = await store.addFillUp(draft(10_300), car.id);
    await store.removeFillUp(gone.id);
    const before = await store.exportSnapshot();
    await store.restamp('fillUps', [live.id, gone.id]);
    const after = await store.exportSnapshot();
    for (const id of [live.id, gone.id]) {
      const was = before.fillUps.find((f) => f.id === id)!;
      const now = after.fillUps.find((f) => f.id === id)!;
      expect(now.updatedAt).toBeGreaterThan(was.updatedAt);
      expect({ ...now, updatedAt: 0 }).toEqual({ ...was, updatedAt: 0 });
    }
  });

  test('an unknown id is ignored', async () => {
    const store = new FuelTrackerStore(memory());
    await expect(store.restamp('vehicles', ['nope'])).resolves.toBeUndefined();
    expect((await store.exportSnapshot()).vehicles).toHaveLength(0);
  });
});

describe('who entered it, through a backup', () => {
  test('a JSON backup keeps it, and restoring brings it back', async () => {
    const { parseJsonBackup, toJsonBackup } = await import('./backupFormat');
    const store = new FuelTrackerStore(memory(), undefined, 'partner');
    const car = await store.addVehicle({ name: 'Civic' });
    const entry = await store.addFillUp(draft(), car.id);
    const parsed = parseJsonBackup(toJsonBackup(await store.exportSnapshot()));
    expect(parsed.value?.fillUps.find((f) => f.id === entry.id)?.enteredBy).toBe('partner');

    const restored = new FuelTrackerStore(memory(), undefined, 'someone-else');
    await restored.importBackup(parsed.value!);
    expect((await restored.fillUp(entry.id))?.enteredBy).toBe('partner');
  });

  test('a backup made before sharing restores with nobody named', async () => {
    const { parseJsonBackup, toJsonBackup } = await import('./backupFormat');
    const store = new FuelTrackerStore(memory());
    const car = await store.addVehicle({ name: 'Civic' });
    await store.addFillUp(draft(), car.id);
    const snapshot = await store.exportSnapshot();
    const old = { ...snapshot, fillUps: snapshot.fillUps.map(({ enteredBy: _who, ...rest }) => rest) };
    const parsed = parseJsonBackup(toJsonBackup(old as typeof snapshot));
    expect(parsed.value?.fillUps[0]?.enteredBy).toBeNull();
  });

  test('a forged enteredBy in a file is bounded like any text from outside', async () => {
    const { parseJsonBackup, toJsonBackup } = await import('./backupFormat');
    const store = new FuelTrackerStore(memory(), undefined, 'me');
    const car = await store.addVehicle({ name: 'Civic' });
    await store.addFillUp(draft(), car.id);
    const snapshot = await store.exportSnapshot();
    const forged = { ...snapshot, fillUps: snapshot.fillUps.map((f) => ({ ...f, enteredBy: 'x'.repeat(10_000) })) };
    const parsed = parseJsonBackup(toJsonBackup(forged));
    expect(parsed.value?.fillUps[0]?.enteredBy).toBeNull();
  });
});
