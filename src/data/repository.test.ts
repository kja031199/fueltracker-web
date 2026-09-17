import { describe, expect, test } from 'vitest';
import 'fake-indexeddb/auto';
import type { Repository } from './repository';
import { InMemoryRepository } from './repository';
import { DexieRepository, FuelTrackerDatabase } from './db';
import type { VehicleRecord } from './records';
import { SCHEMA_VERSION } from './records';

function vehicle(id: string, overrides: Partial<VehicleRecord> = {}): VehicleRecord {
  return {
    id,
    updatedAt: 1_000,
    deletedAt: null,
    schemaVersion: SCHEMA_VERSION,
    name: `Car ${id}`,
    make: '',
    model: '',
    year: 2021,
    createdAt: 1_000,
    ...overrides,
  };
}

/**
 * Both implementations are held to the same contract, in the same tests.
 *
 * That is the point of having two: if the interface had quietly grown a
 * Dexie-shaped hole, the in-memory implementation could not satisfy it — and if
 * a test only ever ran against the Map, the real store could drift without
 * anything noticing.
 */
const implementations: [string, () => Promise<Repository<VehicleRecord>>][] = [
  ['InMemoryRepository', async () => new InMemoryRepository<VehicleRecord>()],
  [
    'DexieRepository',
    async () => {
      // A fresh database per case, so no test can see another's rows.
      const db = new FuelTrackerDatabase(`test-${crypto.randomUUID()}`);
      await db.open();
      return new DexieRepository<VehicleRecord>(db.vehicles);
    },
  ],
];

describe.each(implementations)('%s', (_name, make) => {
  test('stores and reads back by id', async () => {
    const repo = await make();
    await repo.put(vehicle('a'));
    expect((await repo.get('a'))?.name).toBe('Car a');
    expect(await repo.list()).toHaveLength(1);
  });

  test('put replaces by id rather than duplicating', async () => {
    const repo = await make();
    await repo.put(vehicle('a', { name: 'First' }));
    await repo.put(vehicle('a', { name: 'Second' }));
    expect(await repo.list()).toHaveLength(1);
    expect((await repo.get('a'))?.name).toBe('Second');
  });

  test('a missing id reads as undefined, not an error', async () => {
    const repo = await make();
    expect(await repo.get('nope')).toBeUndefined();
  });

  test('remove tombstones rather than dropping the row', async () => {
    // The whole reason deletion is soft: a hard delete leaves nothing to
    // propagate, so a row deleted on one device reappears from another.
    const repo = await make();
    await repo.put(vehicle('a'));
    await repo.remove('a');

    expect(await repo.get('a')).toBeUndefined();
    expect(await repo.list()).toHaveLength(0);

    const tombstones = await repo.listDeleted();
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]?.id).toBe('a');
    expect(tombstones[0]?.deletedAt).not.toBeNull();
  });

  test('removing twice is a no-op and keeps the first timestamp', async () => {
    const repo = await make();
    await repo.put(vehicle('a'));
    await repo.remove('a');
    const first = (await repo.listDeleted())[0]?.deletedAt;
    await repo.remove('a');
    expect((await repo.listDeleted())[0]?.deletedAt).toBe(first);
  });

  test('removing something absent is a no-op, not an error', async () => {
    const repo = await make();
    await expect(repo.remove('nope')).resolves.toBeUndefined();
    expect(await repo.listDeleted()).toHaveLength(0);
  });

  test('a tombstoned row can be revived by putting it back live', async () => {
    // Which is what a sync reconciliation would do on a later edit.
    const repo = await make();
    await repo.put(vehicle('a'));
    await repo.remove('a');
    await repo.put(vehicle('a', { name: 'Back', updatedAt: 2_000 }));
    expect((await repo.get('a'))?.name).toBe('Back');
    expect(await repo.listDeleted()).toHaveLength(0);
  });

  test('list excludes tombstones while keeping live rows', async () => {
    const repo = await make();
    await repo.put(vehicle('a'));
    await repo.put(vehicle('b'));
    await repo.put(vehicle('c'));
    await repo.remove('b');

    const live = (await repo.list()).map((row) => row.id).sort();
    expect(live).toEqual(['a', 'c']);
    expect((await repo.listDeleted()).map((row) => row.id)).toEqual(['b']);
  });

  test('an empty store lists nothing', async () => {
    const repo = await make();
    expect(await repo.list()).toHaveLength(0);
    expect(await repo.listDeleted()).toHaveLength(0);
  });

  test('every stored row carries the four sync fields', async () => {
    const repo = await make();
    await repo.put(vehicle('a'));
    const row = await repo.get('a');
    expect(row?.id).toBe('a');
    expect(typeof row?.updatedAt).toBe('number');
    expect(row?.deletedAt).toBeNull();
    expect(row?.schemaVersion).toBe(SCHEMA_VERSION);
  });
});

describe('InMemoryRepository specifics', () => {
  test('accepts a seed and does not alias the caller array', async () => {
    const seed = [vehicle('a'), vehicle('b')];
    const repo = new InMemoryRepository<VehicleRecord>(seed);
    seed.length = 0;
    expect(await repo.list()).toHaveLength(2);
  });
});

describe('DexieRepository persistence', () => {
  test('rows survive closing and reopening the database', async () => {
    // The point of IndexedDB rather than a Map: this is what makes the app
    // useful across a page reload.
    const name = `test-${crypto.randomUUID()}`;
    const first = new FuelTrackerDatabase(name);
    await first.open();
    await new DexieRepository<VehicleRecord>(first.vehicles).put(vehicle('a', { name: 'Kept' }));
    first.close();

    const second = new FuelTrackerDatabase(name);
    await second.open();
    const reopened = await new DexieRepository<VehicleRecord>(second.vehicles).get('a');
    expect(reopened?.name).toBe('Kept');
    second.close();
  });

  test('the three tables are separate', async () => {
    const db = new FuelTrackerDatabase(`test-${crypto.randomUUID()}`);
    await db.open();
    await new DexieRepository<VehicleRecord>(db.vehicles).put(vehicle('a'));
    expect(await db.fillUps.count()).toBe(0);
    expect(await db.pendingFillUps.count()).toBe(0);
    db.close();
  });
});
