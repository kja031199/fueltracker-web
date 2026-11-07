/**
 * The whole persistence abstraction.
 *
 * A handful of methods, deliberately, and no query builder. Sync and conflict
 * resolution are not in here: they live above it (`sync.ts`, `syncClock.ts`)
 * and use nothing but these methods, which is what keeps every storage engine
 * interchangeable underneath them. The one per-vehicle read, `listForVehicle`,
 * is on `VehicleScopedRepository` rather than here, because only fill-ups and
 * pending fill-ups have a vehicle (#53).
 *
 * Two implementations exist and both matter: `DexieRepository` is what the app
 * runs on, and `InMemoryRepository` below is what the tests run on and what a
 * demo session uses. Having the second one is not busywork — it is the proof
 * that this interface has not quietly grown a Dexie-shaped hole in it.
 */

import type { SyncFields } from './records';

export interface Repository<T extends SyncFields> {
  /** Every live record. Tombstoned rows are **excluded**. */
  list(): Promise<T[]>;
  /** One record by id, or `undefined`. A tombstoned row reads as absent. */
  get(id: string): Promise<T | undefined>;
  /** Insert or replace by id. */
  put(record: T): Promise<void>;
  /**
   * Soft-delete: replaces the row with the tombstone `toTombstone` builds, so
   * the deletion is itself a fact that can be synced. A record that is already
   * gone is a no-op, never an error.
   *
   * **The caller supplies the shape, and that is the point.** This layer is
   * generic over `T` and cannot know which of a record's fields are content,
   * so when it built the tombstone itself the only thing it could write was
   * `{ ...row, deletedAt: now }` — which kept the receipt photograph of a
   * fill-up somebody had just deleted (#25). The builders live in
   * `tombstone.ts`, where the record types are known, and there is now no code
   * path that can spread a whole row into a tombstone by accident.
   *
   * It also carries the stamp, so a deletion is timed by the **same clock as
   * every other write**. Reading `Date.now()` here instead would leave
   * tombstones on the wall clock while edits moved to the monotonic one, and a
   * delete would go on losing to a row from a device whose clock is ahead —
   * the whole failure `syncClock.ts` exists to close.
   */
  remove(id: string, toTombstone: (row: T) => T): Promise<void>;
  /**
   * Tombstoned records: exported, merged on import, and re-thinned by
   * `scrubTombstones`. A tombstone nobody can enumerate is just a leak.
   */
  listDeleted(): Promise<T[]>;
  /**
   * Every row, live **and** tombstoned, in one read (#87). What a full
   * snapshot needs — an export, or sync's one look at the device — and half
   * the cost of `list()` plus `listDeleted()`, which each read the whole table.
   */
  listAll(): Promise<T[]>;
  /**
   * The rows with these ids, **live or tombstoned**; an id that is not stored
   * is simply absent from the result (#87). For "have I seen this one?" —
   * which used to scan every tombstone, because `get` hides them.
   */
  getMany(ids: readonly string[]): Promise<T[]>;
  /**
   * How many live records there are, without reading them (#53). The backup
   * reminder asks after every save, and reading every row — every receipt
   * photo — to return one number was the most wasteful query in the app.
   */
  countLive(): Promise<number>;
  /**
   * **Hard**-deletes a row, leaving no tombstone. Not a way to delete anything
   * that is yours — that is `remove`, whose tombstone syncs. This exists for
   * one case only: forgetting the rows of a car that was shared *with* this
   * account once that access ends (#66). Those rows were never this account's
   * to delete, and a tombstone would try to push a deletion of the owner's
   * data. Only `FuelTrackerStore.forgetVehicle` calls it.
   */
  purge(id: string): Promise<void>;
}

/**
 * A repository whose rows belong to a vehicle, and can be read one vehicle at
 * a time (#53).
 *
 * Every per-vehicle question — the fill-up list, the dashboard, removing a
 * vehicle — used to `list()` the whole table and filter, so one vehicle's
 * history cost every vehicle's, receipts included. Dexie answers this from the
 * `vehicleId` index, which had been declared since the first schema and never
 * queried.
 */
export interface VehicleScopedRepository<T extends SyncFields & { readonly vehicleId: string }>
  extends Repository<T> {
  /** One vehicle's live records. */
  listForVehicle(vehicleId: string): Promise<T[]>;
  /** One vehicle's records, tombstones included, from the same index (#87). */
  listForVehicleAll(vehicleId: string): Promise<T[]>;
}

/**
 * A `Repository` backed by a plain `Map`.
 *
 * Used by the test suite and by a demo session that should leave nothing
 * behind. Records are stored as handed over — they are readonly interfaces, so
 * the caller cannot mutate one afterwards and change what is "stored" — and
 * returned in insertion order, which keeps test expectations legible.
 */
export class InMemoryRepository<T extends SyncFields> implements Repository<T> {
  private readonly rows = new Map<string, T>();

  constructor(seed: readonly T[] = []) {
    for (const record of seed) this.rows.set(record.id, record);
  }

  async list(): Promise<T[]> {
    return [...this.rows.values()].filter((row) => row.deletedAt === null);
  }

  async get(id: string): Promise<T | undefined> {
    const row = this.rows.get(id);
    return row === undefined || row.deletedAt !== null ? undefined : row;
  }

  async put(record: T): Promise<void> {
    this.rows.set(record.id, record);
  }

  async remove(id: string, toTombstone: (row: T) => T): Promise<void> {
    const row = this.rows.get(id);
    if (row === undefined || row.deletedAt !== null) return;
    this.rows.set(id, toTombstone(row));
  }

  async listDeleted(): Promise<T[]> {
    return [...this.rows.values()].filter((row) => row.deletedAt !== null);
  }

  async listAll(): Promise<T[]> {
    return [...this.rows.values()];
  }

  async getMany(ids: readonly string[]): Promise<T[]> {
    const found: T[] = [];
    for (const id of new Set(ids)) {
      const row = this.rows.get(id);
      if (row !== undefined) found.push(row);
    }
    return found;
  }

  async purge(id: string): Promise<void> {
    this.rows.delete(id);
  }

  async countLive(): Promise<number> {
    let live = 0;
    for (const row of this.rows.values()) if (row.deletedAt === null) live += 1;
    return live;
  }

  /**
   * One vehicle's live records. Implemented for every record type so one class
   * serves all three tables in tests; on a row with no `vehicleId` it simply
   * matches nothing.
   */
  async listForVehicle(vehicleId: string): Promise<T[]> {
    return (await this.listForVehicleAll(vehicleId)).filter((row) => row.deletedAt === null);
  }

  async listForVehicleAll(vehicleId: string): Promise<T[]> {
    return [...this.rows.values()].filter(
      (row) => (row as { readonly vehicleId?: unknown }).vehicleId === vehicleId,
    );
  }
}
