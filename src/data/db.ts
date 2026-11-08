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
 * The schema only (#91). Its adapters are beside it: `dexieRepository.ts` for
 * the rows, `dexieState.ts` for the sync cursor and the share ledger.
 *
 * The filtering the app does — search text, fuel grade, station — is a pure
 * in-memory pass over one vehicle's history by design (see `fillUpFilter.ts`),
 * not a database query.
 */

import Dexie from 'dexie';
import type { Table } from 'dexie';
import type { FillUpRecord, PendingFillUpRecord, VehicleRecord } from './records';

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
