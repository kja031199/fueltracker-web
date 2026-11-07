/**
 * The IndexedDB store, via Dexie.
 *
 * Dexie is a thin typed wrapper over IndexedDB — chosen over the raw API
 * because the raw API is event-based and unpleasant to get right, and over a
 * heavier sync-capable database because nothing here needs one yet.
 *
 * ## What is indexed, and what each index is for
 *
 * - `id` — the primary key.
 * - `vehicleId` — **`listForVehicle`**: the fill-up list, the dashboard and
 *   removing a vehicle read one vehicle's rows, not the table (#53). It was
 *   declared from the first schema and, until #53, never queried: every read
 *   was `toArray()` and a filter, so one vehicle cost every vehicle's rows and
 *   every receipt photo in them.
 * - `deletedAt` — **`countLive`**, without reading a row. IndexedDB leaves a
 *   `null` key out of an index, so this index holds only tombstones, and live
 *   rows are the table's count minus the index's. An earlier note here called
 *   indexing a mostly-null field "the index that earns nothing"; it earns
 *   exactly this, because the nulls cost nothing to leave out.
 * - `date` — declared, not yet queried; rows are sorted in memory after the
 *   per-vehicle read, which is small. Kept rather than dropped, because
 *   dropping an index is a schema change of its own.
 *
 * The filtering the app does — search text, fuel grade, station — is a pure
 * in-memory pass over one vehicle's history by design (see `fillUpFilter.ts`),
 * not a database query.
 */

import Dexie from 'dexie';
import type { Table } from 'dexie';
import type { FillUpRecord, PendingFillUpRecord, SyncFields, VehicleRecord } from './records';
import type { Repository } from './repository';
import type { Repositories } from './store';
import type { SyncCursor, SyncStateStore } from './syncState';
import { parseCursor, parseLedger, type ShareLedger } from './syncState';
import type { Membership } from './sharing';

export class FuelTrackerDatabase extends Dexie {
  declare vehicles: Table<VehicleRecord, string>;
  declare fillUps: Table<FillUpRecord, string>;
  declare pendingFillUps: Table<PendingFillUpRecord, string>;
  declare syncState: Table<{ readonly key: string } & Record<string, unknown>, string>;

  /**
   * `name` is required (#57). Its default used to be `'fueltracker'`, the
   * legacy database every account once shared, which #44 stopped opening;
   * `databaseNameFor(uid)` in `accountStore.ts` is where real names come from.
   */
  constructor(name: string) {
    super(name);
    this.version(1).stores({
      vehicles: 'id',
      fillUps: 'id, vehicleId, date',
      pendingFillUps: 'id, vehicleId',
    });
    // Version 2 adds where incremental sync keeps its place (#52). Adding a
    // table touches no existing row; `syncState.test.ts` opens a version-1
    // database with this code to prove it.
    this.version(2).stores({
      vehicles: 'id',
      fillUps: 'id, vehicleId, date',
      pendingFillUps: 'id, vehicleId',
      syncState: 'key',
    });
    // Version 3 indexes `deletedAt` (#53), so live rows can be counted without
    // reading any. Adding an index moves no data; `dexieIndexes.test.ts` opens
    // a version-2 database, rows and sync cursor included, to prove it.
    this.version(3).stores({
      vehicles: 'id, deletedAt',
      fillUps: 'id, vehicleId, date, deletedAt',
      pendingFillUps: 'id, vehicleId, deletedAt',
      syncState: 'key',
    });
  }
}

/**
 * The sync cursor, in the same database as the rows it describes (#52), so
 * the two can only ever be cleared together. See `syncState.ts`.
 */
export class DexieSyncState implements SyncStateStore {
  /**
   * `key` names whose cursor this is: `'cursor'` for the account's own tree,
   * and one key per car shared with it (#66), since each is read separately.
   */
  constructor(
    private readonly db: FuelTrackerDatabase,
    private readonly key: string = 'cursor',
  ) {}

  async load(): Promise<SyncCursor | null> {
    const row = await this.db.syncState.get(this.key);
    return parseCursor(row?.['cursor']);
  }

  async save(cursor: SyncCursor): Promise<void> {
    await this.db.syncState.put({ key: this.key, cursor });
  }

  async clear(): Promise<void> {
    await this.db.syncState.delete(this.key);
  }
}

/**
 * The cars this device holds because they were shared with it (#66), kept so
 * that one which stops being shared — left on another device, or removed by
 * its owner — is recognised as such and forgotten here too.
 */
export class DexieShareLedger implements ShareLedger {
  constructor(private readonly db: FuelTrackerDatabase) {}

  async load(): Promise<Membership[]> {
    const row = await this.db.syncState.get('shares');
    return parseLedger(row?.['shares']);
  }

  async save(list: readonly Membership[]): Promise<void> {
    await this.db.syncState.put({ key: 'shares', shares: [...list] });
  }
}

/**
 * A `Repository` over one Dexie table.
 *
 * `list()` and `listAll()` read the whole table — an export and sync's one
 * snapshot need every row, receipts included. Everything else goes through an
 * index or the primary key: `listDeleted` the `deletedAt` index, `getMany` the
 * key, the per-vehicle reads the `vehicleId` index (#53, #87).
 */
export class DexieRepository<T extends SyncFields> implements Repository<T> {
  /**
   * `inTransaction`: the table is one a transaction handed out
   * (`transaction.table(...)`), so every call is already part of it.
   */
  constructor(
    private readonly table: Table<T, string>,
    private readonly inTransaction = false,
  ) {}

  /**
   * One vehicle's live rows, from the `vehicleId` index. Only meaningful on a
   * table that has the index (fill-ups, submissions); Dexie refuses the query
   * on one that does not, which is the right failure for a programming error.
   */
  async listForVehicle(vehicleId: string): Promise<T[]> {
    return (await this.listForVehicleAll(vehicleId)).filter((row) => row.deletedAt === null);
  }

  /** One vehicle's rows, tombstones included, from the `vehicleId` index. */
  async listForVehicleAll(vehicleId: string): Promise<T[]> {
    return this.table.where('vehicleId').equals(vehicleId).toArray();
  }

  async listAll(): Promise<T[]> {
    return this.table.toArray();
  }

  /** By primary key; ids not stored are left out. */
  async getMany(ids: readonly string[]): Promise<T[]> {
    const rows = await this.table.bulkGet([...new Set(ids)]);
    return rows.filter((row): row is T => row !== undefined);
  }

  /** Live rows counted from two indexes, reading none of them. See above. */
  async countLive(): Promise<number> {
    const [all, tombstones] = await Promise.all([
      this.table.count(),
      this.table.where('deletedAt').aboveOrEqual(Number.NEGATIVE_INFINITY).count(),
    ]);
    return all - tombstones;
  }

  async list(): Promise<T[]> {
    const rows = await this.table.toArray();
    return rows.filter((row) => row.deletedAt === null);
  }

  async get(id: string): Promise<T | undefined> {
    const row = await this.table.get(id);
    return row === undefined || row.deletedAt !== null ? undefined : row;
  }

  async put(record: T): Promise<void> {
    await this.table.put(record);
  }

  async putMany(records: readonly T[]): Promise<void> {
    if (records.length > 0) await this.table.bulkPut([...records]);
  }

  /**
   * Read and write in one transaction (#85), so a save that lands between
   * them cannot be replaced by a tombstone built from the row as it was.
   * Inside a `transaction` of the whole store, this joins that one.
   */
  async remove(id: string, toTombstone: (row: T) => T): Promise<void> {
    const tombstone = async (table: Table<T, string>): Promise<void> => {
      const row = await table.get(id);
      if (row === undefined || row.deletedAt !== null) return;
      await table.put(toTombstone(row));
    };
    if (this.inTransaction) return tombstone(this.table);
    await this.table.db.transaction('rw', this.table, (tx) =>
      tombstone(tx.table(this.table.name) as Table<T, string>),
    );
  }

  /**
   * From the `deletedAt` index, which holds only tombstones: a live row's
   * `deletedAt` is `null`, which IndexedDB does not index. The same trick
   * `countLive` uses — and it reads no live row, receipt or otherwise.
   */
  async listDeleted(): Promise<T[]> {
    return this.table.where('deletedAt').aboveOrEqual(Number.NEGATIVE_INFINITY).toArray();
  }

  async purge(id: string): Promise<void> {
    await this.table.delete(id);
  }
}

/**
 * The store's three tables, with a `transaction` over all of them (#85).
 *
 * The one place the app's repositories are built, so the transaction cannot
 * be left off: without it, every merge and cascade runs as one write per row,
 * and a save that lands in between is lost or a delete is half done.
 */
export function dexieRepositories(db: FuelTrackerDatabase): Repositories {
  return {
    vehicles: new DexieRepository(db.vehicles),
    fillUps: new DexieRepository(db.fillUps),
    pendingFillUps: new DexieRepository(db.pendingFillUps),
    transaction: (work) =>
      db.transaction('rw', db.vehicles, db.fillUps, db.pendingFillUps, (tx) =>
        // Tables taken from the transaction itself, not `db`: every call on
        // them is part of it however many `await`s away it is made. See
        // `Repositories.transaction`.
        work({
          vehicles: new DexieRepository(tx.table(db.vehicles.name) as Table<VehicleRecord, string>, true),
          fillUps: new DexieRepository(tx.table(db.fillUps.name) as Table<FillUpRecord, string>, true),
          pendingFillUps: new DexieRepository(
            tx.table(db.pendingFillUps.name) as Table<PendingFillUpRecord, string>,
            true,
          ),
        }),
      ),
  };
}
