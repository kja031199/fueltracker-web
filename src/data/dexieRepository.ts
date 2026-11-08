/**
 * The store's rows in the account's database (#91: apart from the schema in
 * `db.ts`): a `Repository` per table, and the transaction over all three.
 */

import type { Table } from 'dexie';
import type { FuelTrackerDatabase } from './db';
import type { FillUpRecord, PendingFillUpRecord, SyncFields, VehicleRecord } from './records';
import type { Repositories, Repository } from './repository';

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
