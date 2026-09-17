/**
 * The IndexedDB store, via Dexie.
 *
 * Dexie is a thin typed wrapper over IndexedDB — chosen over the raw API
 * because the raw API is event-based and unpleasant to get right, and over a
 * heavier sync-capable database because nothing here needs one yet.
 *
 * ## What is indexed, and why so little
 *
 * `id` is the primary key; `vehicleId` and `date` are indexed because the
 * fill-up list and every chart query by vehicle and order by date. Nothing else
 * is indexed: an index that no query uses costs a write on every insert and
 * buys nothing, and the filtering the app actually does — search text, fuel
 * grade, station — is a pure in-memory pass over one vehicle's history by
 * design (see `fillUpFilter.ts`), not a database query.
 *
 * `deletedAt` is **not** indexed either. Tombstones are rare and the live-row
 * filter runs in memory; indexing a field that is null on almost every row is
 * the classic index that earns nothing.
 */

import Dexie from 'dexie';
import type { Table } from 'dexie';
import type { FillUpRecord, PendingFillUpRecord, SyncFields, VehicleRecord } from './records';
import type { Repository } from './repository';

export const DATABASE_NAME = 'fueltracker';

export class FuelTrackerDatabase extends Dexie {
  declare vehicles: Table<VehicleRecord, string>;
  declare fillUps: Table<FillUpRecord, string>;
  declare pendingFillUps: Table<PendingFillUpRecord, string>;

  constructor(name: string = DATABASE_NAME) {
    super(name);
    this.version(1).stores({
      vehicles: 'id',
      fillUps: 'id, vehicleId, date',
      pendingFillUps: 'id, vehicleId',
    });
  }
}

/**
 * A `Repository` over one Dexie table.
 *
 * The live/tombstoned split is applied **in memory** rather than through an
 * index, for the reason given above. One vehicle's history is hundreds of rows,
 * not millions.
 */
export class DexieRepository<T extends SyncFields> implements Repository<T> {
  constructor(private readonly table: Table<T, string>) {}

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

  async remove(id: string): Promise<void> {
    const row = await this.table.get(id);
    if (row === undefined || row.deletedAt !== null) return;
    const now = Date.now();
    await this.table.put({ ...row, deletedAt: now, updatedAt: now });
  }

  async listDeleted(): Promise<T[]> {
    const rows = await this.table.toArray();
    return rows.filter((row) => row.deletedAt !== null);
  }
}
