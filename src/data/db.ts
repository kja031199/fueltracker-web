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
import type { SyncCursor, SyncStateStore } from './syncState';
import { parseCursor } from './syncState';

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
  constructor(private readonly db: FuelTrackerDatabase) {}

  async load(): Promise<SyncCursor | null> {
    const row = await this.db.syncState.get('cursor');
    return parseCursor(row?.['cursor']);
  }

  async save(cursor: SyncCursor): Promise<void> {
    await this.db.syncState.put({ key: 'cursor', cursor });
  }
}

/**
 * A `Repository` over one Dexie table.
 *
 * `list()` and `listDeleted()` still read the whole table — export and sync
 * need every row, receipts included. Everything the screens ask for goes
 * through the indexed reads below instead.
 */
export class DexieRepository<T extends SyncFields> implements Repository<T> {
  constructor(private readonly table: Table<T, string>) {}

  /**
   * One vehicle's live rows, from the `vehicleId` index. Only meaningful on a
   * table that has the index (fill-ups, submissions); Dexie refuses the query
   * on one that does not, which is the right failure for a programming error.
   */
  async listForVehicle(vehicleId: string): Promise<T[]> {
    const rows = await this.table.where('vehicleId').equals(vehicleId).toArray();
    return rows.filter((row) => row.deletedAt === null);
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

  async remove(id: string, toTombstone: (row: T) => T): Promise<void> {
    const row = await this.table.get(id);
    if (row === undefined || row.deletedAt !== null) return;
    await this.table.put(toTombstone(row));
  }

  async listDeleted(): Promise<T[]> {
    const rows = await this.table.toArray();
    return rows.filter((row) => row.deletedAt !== null);
  }

  async purge(id: string): Promise<void> {
    await this.table.delete(id);
  }
}
