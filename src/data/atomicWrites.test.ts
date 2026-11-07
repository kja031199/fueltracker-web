/**
 * Merges and cascades are all-or-nothing, and nothing lands in the middle of
 * one (#85).
 *
 * Before, every one of them read, decided, then wrote a row at a time with an
 * `await` in between: a save that landed during a sync's merge was replaced by
 * the older row the pull brought (and, its version now "known", never sent),
 * and a delete interrupted half way left a live car with some of its fill-ups
 * gone. The Dexie tests here run on the real database (fake-indexeddb) through
 * `dexieRepositories`, which is what the app's store is built on.
 */

import { describe, expect, test } from 'vitest';
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { makeFuelEntryDraft } from '../domain/fuelEntryDraft';
import type { FuelEntryDraft } from '../domain/fuelEntryDraft';
import { openAccountStore } from './accountStore';
import { FuelTrackerDatabase, dexieRepositories } from './db';
import { SCHEMA_VERSION, type FillUpRecord, type PendingFillUpRecord, type VehicleRecord } from './records';
import { InMemoryRemoteStore } from './remote';
import { InMemoryRepository } from './repository';
import { FuelTrackerStore, type Repositories } from './store';
import { syncOnce } from './sync';
import { MonotonicClock } from './syncClock';
import { InMemorySyncState } from './syncState';
import { TEXT_LIMITS } from '../domain/textLimits';

function draft(odometer = 10_000): FuelEntryDraft {
  const result = makeFuelEntryDraft({
    date: new Date(1_700_000_000_000),
    odometer,
    gallons: 10,
    pricePerGallon: 3.5,
  });
  if (result === null) throw new Error('fixture draft failed validation');
  return result;
}

function fillUp(overrides: Partial<FillUpRecord> = {}): FillUpRecord {
  return {
    id: 'f1',
    updatedAt: 100,
    deletedAt: null,
    schemaVersion: SCHEMA_VERSION,
    vehicleId: 'v1',
    date: 1_700_000_000_000,
    odometer: 10_000,
    gallons: 10,
    pricePerGallon: 3.5,
    isFullTank: true,
    missedPreviousFillUp: false,
    fuelGrade: 'Regular',
    station: 'Shell',
    notes: '',
    latitude: null,
    longitude: null,
    receiptImageData: null,
    ...overrides,
  };
}

function vehicle(overrides: Partial<VehicleRecord> = {}): VehicleRecord {
  return {
    id: 'v1',
    updatedAt: 100,
    deletedAt: null,
    schemaVersion: SCHEMA_VERSION,
    name: 'Civic',
    make: 'Honda',
    model: 'Civic',
    year: 2019,
    createdAt: 100,
    ...overrides,
  };
}

function pendingRow(overrides: Partial<PendingFillUpRecord> = {}): PendingFillUpRecord {
  return {
    id: 'p1',
    updatedAt: 100,
    deletedAt: null,
    schemaVersion: SCHEMA_VERSION,
    vehicleId: 'v1',
    submittedAt: 100,
    submitterName: 'Sam',
    date: 1_700_000_000_000,
    odometer: 10_000,
    gallons: 10,
    pricePerGallon: 3.5,
    isFullTank: true,
    fuelGrade: 'Regular',
    station: '',
    notes: '',
    latitude: null,
    longitude: null,
    receiptImageData: null,
    ...overrides,
  };
}

/** A fresh device database, its repositories, and a store over them. */
async function dexieStore(): Promise<{ store: FuelTrackerStore; repos: Repositories }> {
  const db = new FuelTrackerDatabase(`atomic-${crypto.randomUUID()}`);
  await db.open();
  const repos = dexieRepositories(db);
  return { store: new FuelTrackerStore(repos), repos };
}

function memoryStore(): { store: FuelTrackerStore; repos: Repositories } {
  const repos: Repositories = {
    vehicles: new InMemoryRepository<VehicleRecord>(),
    fillUps: new InMemoryRepository<FillUpRecord>(),
    pendingFillUps: new InMemoryRepository<PendingFillUpRecord>(),
  };
  return { store: new FuelTrackerStore(repos), repos };
}

/**
 * `repo` with these methods failing, standing in for a write the disk refuses
 * (quota, a closed tab): every other call goes through to the real one.
 */
function failing<T extends object>(repo: T, methods: readonly string[]): T {
  return new Proxy(repo, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && methods.includes(prop)) {
        return async () => {
          throw new Error('disk full');
        };
      }
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

const WRITES = ['put', 'putMany', 'remove', 'purge'] as const;

type Table = 'vehicles' | 'fillUps' | 'pendingFillUps';

/**
 * `repos` with one table swapped for `wrap(table)` — outside a transaction
 * and inside one, since a transaction hands its work repositories of its own.
 */
function swapping(repos: Repositories, name: Table, wrap: <T extends object>(repo: T) => T): Repositories {
  const { transaction } = repos;
  return {
    ...repos,
    [name]: wrap(repos[name]),
    ...(transaction === undefined
      ? {}
      : { transaction: (work) => transaction((inside) => work({ ...inside, [name]: wrap(inside[name]) })) }),
  } as Repositories;
}

/** `repos` whose writes to one table fail. */
function breaking(repos: Repositories, name: Table): Repositories {
  return swapping(repos, name, (repo) => failing(repo, WRITES));
}

/**
 * `repo` whose `method` calls `then` once, right after it reads — from
 * outside any transaction, as a click handler would — standing in for a write
 * that lands just after a decision has looked at what is stored.
 */
function readThen<T extends object>(repo: T, then: () => void, method = 'getMany'): T {
  return new Proxy(repo, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      const bound = (value as (...args: unknown[]) => unknown).bind(target);
      if (prop !== method) return bound;
      return async (...args: unknown[]) => {
        const rows = await bound(...args);
        Dexie.ignoreTransaction(then);
        return rows;
      };
    },
  });
}

/** `then`, once, however often it is called. */
function once(then: () => void): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    then();
  };
}

describe('a save that lands while sync merges (#85)', () => {
  test('is kept, not replaced by the older row the pull brought, and is sent next sync', async () => {
    const db = new FuelTrackerDatabase(`atomic-${crypto.randomUUID()}`);
    await db.open();
    const repos = dexieRepositories(db);
    const clock = new MonotonicClock();
    const store = new FuelTrackerStore(repos, clock);
    const car = await store.addVehicle({ name: 'Civic' });
    const mine = await store.addFillUp(draft(10_000), car.id);

    // Another device has corrected the fill-up — newer than this device's
    // copy, older than the edit below — and logged a history beside it, which
    // the pull returns first: the merge writes all of that before this row.
    const theirs = fillUp({ id: mine.id, vehicleId: car.id, updatedAt: mine.updatedAt + 1, odometer: 20_000 });
    const history = Array.from({ length: 50 }, (_, i) =>
      fillUp({ id: `h-${i}`, vehicleId: car.id, updatedAt: mine.updatedAt + 1, odometer: 1_000 + i }),
    );
    const remote = new InMemoryRemoteStore({ vehicles: [car], fillUps: [...history, theirs], pendingFillUps: [] });
    const state = new InMemorySyncState();

    // The edit is saved the moment the merge has read the fill-ups it was sent.
    let editing: Promise<unknown> = Promise.resolve();
    const edit = once(() => {
      editing = store.updateFillUp(mine.id, draft(30_000));
    });
    const racing = new FuelTrackerStore(swapping(repos, 'fillUps', (repo) => readThen(repo, edit)), clock);
    await syncOnce(racing, remote, clock, state);
    await editing;

    expect((await store.fillUp(mine.id))?.odometer).toBe(30_000);
    await syncOnce(store, remote, clock, state);
    const held = (await remote.pull()).fillUps as readonly FillUpRecord[];
    expect(held.find((row) => row.id === mine.id)?.odometer).toBe(30_000);
  });

  test('the app’s own store runs a merge as one transaction: a row it cannot store writes nothing', async () => {
    const account = await openAccountStore('uid-atomic', `atomic-${crypto.randomUUID()}`);
    // IndexedDB cannot store a function: this row's write fails, after the
    // car's and the fill-up's have been made.
    const unstorable = { ...pendingRow(), extra: () => undefined } as unknown as PendingFillUpRecord;

    await expect(
      account.store.importBackup({ vehicles: [vehicle()], fillUps: [fillUp()], pendingFillUps: [unstorable] }),
    ).rejects.toThrow();

    expect(await account.store.vehicles()).toEqual([]);
    expect(await account.store.fillUpCount()).toBe(0);
    account.close();
  });
});

describe('a save and a deletion at once (#85)', () => {
  test('a fill-up deleted just after the edit checked it stays deleted', async () => {
    const { store, repos } = await dexieStore();
    const car = await store.addVehicle({ name: 'Civic' });
    const entry = await store.addFillUp(draft(10_000), car.id);

    // Deleted (a sync, another tab) just after the edit has checked the car.
    let deleting: Promise<unknown> = Promise.resolve();
    const remove = once(() => {
      deleting = store.removeFillUp(entry.id);
    });
    const editing = new FuelTrackerStore(swapping(repos, 'vehicles', (repo) => readThen(repo, remove, 'get')));
    await editing.updateFillUp(entry.id, draft(30_000));
    await deleting;

    // The edit used to write the row back after the deletion: undeleted.
    expect(await store.fillUp(entry.id)).toBeUndefined();
  });

  test('the same link opened twice at once is queued once', async () => {
    const { store } = await dexieStore();
    const car = await store.addVehicle({ name: 'Civic' });
    const link = {
      id: 'sub-1',
      vehicleId: car.id,
      submittedAt: 100,
      submitterName: 'Sam',
      draft: draft(),
    };

    const results = await Promise.all([store.receiveSubmission(link), store.receiveSubmission(link)]);

    expect([...results].sort()).toEqual(['duplicate', 'queued']);
  });
});

describe('removing a car (#85)', () => {
  test.each([
    ['in memory', memoryStore],
    ['on the device', dexieStore],
  ] as const)('tombstones its pending submissions too (%s)', async (_name, make) => {
    const { store } = await make();
    const car = await store.addVehicle({ name: 'Civic' });
    const other = await store.addVehicle({ name: 'Jazz' });
    await store.submitFillUp(draft(), car.id, 'Sam');
    const kept = await store.submitFillUp(draft(), other.id, 'Alex');

    await store.removeVehicle(car.id);

    // Only the other car's submission is still waiting.
    expect((await store.pendingFillUps()).map((row) => row.id)).toEqual([kept.id]);
    // And the removed car's is a thin tombstone: neither name nor note kept.
    const gone = (await store.exportSnapshot()).pendingFillUps.find((row) => row.vehicleId === car.id);
    expect(gone?.deletedAt).not.toBeNull();
    expect(gone?.submitterName).toBe('');
  });

  test('either completes or changes nothing, when a write fails part way', async () => {
    const { repos } = await dexieStore();
    const setup = new FuelTrackerStore(repos);
    const car = await setup.addVehicle({ name: 'Civic' });
    for (let i = 0; i < 5; i += 1) await setup.addFillUp(draft(10_000 + i), car.id);
    await setup.submitFillUp(draft(), car.id, 'Sam');

    // The fill-ups' tombstones are written first; the car's own write fails.
    const broken = new FuelTrackerStore(breaking(repos, 'vehicles'));
    await expect(broken.removeVehicle(car.id)).rejects.toThrow('disk full');

    expect((await setup.vehicles()).map((row) => row.id)).toEqual([car.id]);
    expect(await setup.fillUps(car.id)).toHaveLength(5);
    expect(await setup.pendingFillUps()).toHaveLength(1);
  });
});

describe('forgetting a shared car (#85)', () => {
  test('either completes or changes nothing, when a write fails part way', async () => {
    const { repos } = await dexieStore();
    const setup = new FuelTrackerStore(repos);
    await repos.vehicles.put(vehicle({ id: 'theirs' }));
    await repos.fillUps.putMany([fillUp({ id: 'a', vehicleId: 'theirs' }), fillUp({ id: 'b', vehicleId: 'theirs' })]);

    const broken = new FuelTrackerStore(breaking(repos, 'vehicles'));
    await expect(broken.forgetVehicle('theirs')).rejects.toThrow('disk full');

    expect(await setup.hasVehicle('theirs')).toBe(true);
    expect(await setup.fillUps('theirs')).toHaveLength(2);
  });
});

describe('a merge (#85)', () => {
  test('either lands whole or not at all, when a write fails part way', async () => {
    const { repos } = await dexieStore();
    const setup = new FuelTrackerStore(repos);
    const broken = new FuelTrackerStore(breaking(repos, 'pendingFillUps'));
    const submission = pendingRow();

    await expect(
      broken.importBackup({ vehicles: [vehicle()], fillUps: [fillUp()], pendingFillUps: [submission] }),
    ).rejects.toThrow('disk full');

    expect(await setup.vehicles()).toEqual([]);
    expect(await setup.fillUpCount()).toBe(0);
  });

  test('that names one row twice keeps the newer, in whichever order', async () => {
    for (const order of [
      [5, 9],
      [9, 5],
    ]) {
      const { store } = memoryStore();
      const rows = order.map((at) => vehicle({ updatedAt: at, name: `v${at}` }));

      const summary = await store.importBackup({ vehicles: rows, fillUps: [], pendingFillUps: [] });

      expect((await store.vehicles())[0]?.name).toBe('v9');
      expect(summary.vehiclesWritten + summary.skippedOlder).toBe(2);
    }
  });
});

describe('approving a submission (#85)', () => {
  test('either completes or changes nothing: no fill-up without the queue entry cleared', async () => {
    const { repos } = await dexieStore();
    const setup = new FuelTrackerStore(repos);
    const car = await setup.addVehicle({ name: 'Civic' });
    const pending = await setup.submitFillUp(draft(), car.id, 'Sam');

    const broken = new FuelTrackerStore(breaking(repos, 'pendingFillUps'));
    await expect(broken.approvePendingFillUp(pending.id)).rejects.toThrow('disk full');

    // Approving again would otherwise log it twice.
    expect(await setup.fillUps(car.id)).toEqual([]);
    expect((await setup.pendingFillUps()).map((row) => row.id)).toEqual([pending.id]);
  });
});

describe('repairing oversized text (#85)', () => {
  test('repairs from the row as it is now, not as sync read it', async () => {
    const { store, repos } = memoryStore();
    const long = 'x'.repeat(TEXT_LIMITS.notes + 50);
    const stale = fillUp({ notes: long, updatedAt: 100 });
    // Edited since sync took its look: the note now fits, and it is newer.
    await repos.fillUps.put(fillUp({ notes: 'fixed by hand', odometer: 12_345, updatedAt: 200 }));

    const ids = await store.repairOversizedTextIn({ vehicles: [], fillUps: [stale], pendingFillUps: [] });

    expect(ids.fillUps).toEqual([]);
    const now = await repos.fillUps.get('f1');
    expect(now?.notes).toBe('fixed by hand');
    expect(now?.odometer).toBe(12_345);
  });

  test('still repairs a row that is still too long, keeping its newer edits', async () => {
    const { store, repos } = memoryStore();
    const long = 'x'.repeat(TEXT_LIMITS.notes + 50);
    await repos.fillUps.put(fillUp({ notes: long, odometer: 12_345, updatedAt: 200 }));

    const ids = await store.repairOversizedTextIn({
      vehicles: [],
      fillUps: [fillUp({ notes: long, updatedAt: 100 })],
      pendingFillUps: [],
    });

    expect(ids.fillUps).toEqual(['f1']);
    const now = await repos.fillUps.get('f1');
    expect(now?.notes).toHaveLength(TEXT_LIMITS.notes);
    expect(now?.odometer).toBe(12_345);
    expect(now?.updatedAt).toBeGreaterThan(200);
  });
});
