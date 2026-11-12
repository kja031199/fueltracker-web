/**
 * The device's rows as sync sees them (#91).
 *
 * Everything only sync does to local storage — read it all, merge what the
 * account holds, re-stamp a tie it won, repair text stored before it was
 * bounded, forget a car no longer shared, re-read rows by id — on its own
 * type. They used to be methods of `FuelTrackerStore` beside the writes the
 * screens make, so nothing in the type kept a screen from calling them. The
 * store builds one of these over its own repositories and clock and hands it
 * to sync (`store.replica`); the store's type has none of them.
 *
 * @trap #91 — Sync functions take a `SyncTarget` and touch storage only through
 * its `replica`; `replica.test.ts` fails to compile if one of these methods
 * reappears on the store. `store.importBackup(snapshot)` is the file import and
 * has **no** tie-break.
 */

import type { ImportSummary, TieBreak } from './backup';
import { exportSnapshot, importBackup } from './backup';
import { atomically } from './atomically';
import type { FillUpRecord, PendingFillUpRecord, Snapshot, SyncFields, VehicleRecord } from './records';
import { boundFillUpText, boundPendingText, boundVehicleText } from './recordText';
import type { Collection } from './remote';
import type { Repositories, Repository } from './repository';
import type { MonotonicClock } from './syncClock';

/**
 * What sync is handed: anything holding a replica — in the app, the store
 * (#91). Sync reaches local storage through `replica` and nothing else.
 */
export interface SyncTarget {
  readonly replica: Replica;
}

export class Replica {
  constructor(
    private readonly repos: Repositories,
    /** The store's clock — the one sync observes the account on (#91). */
    readonly clock: MonotonicClock,
  ) {}

  /** Every row, tombstones included: what sync reads the device as, once (#87). */
  async snapshot(): Promise<Snapshot> {
    return exportSnapshot(this.repos);
  }

  /** Merges what the account holds, settling equal stamps with `tieBreak`. See `backup.ts`. */
  async merge(snapshot: Snapshot, tieBreak: TieBreak): Promise<ImportSummary> {
    return importBackup(this.repos, snapshot, tieBreak);
  }

  /**
   * Whether this device holds a vehicle with that id in any state — live, or
   * deleted and kept as a tombstone. A share whose car id is already here
   * would hand that car to whoever shared it (#78).
   */
  async hasVehicle(id: string): Promise<boolean> {
    return (await this.repos.vehicles.getMany([id])).length > 0;
  }

  /**
   * Rows by id, live **or** tombstoned, for sync (#87): what it merged,
   * re-stamped or repaired, re-read without reading the whole table.
   */
  async rowsById(collection: 'vehicles', ids: readonly string[]): Promise<VehicleRecord[]>;
  async rowsById(collection: 'fillUps', ids: readonly string[]): Promise<FillUpRecord[]>;
  async rowsById(collection: 'pendingFillUps', ids: readonly string[]): Promise<PendingFillUpRecord[]>;
  async rowsById(collection: Collection, ids: readonly string[]): Promise<SyncFields[]> {
    if (ids.length === 0) return [];
    return (this.repos[collection] as Repository<SyncFields>).getMany(ids);
  }

  /**
   * Forgets a car this device held only because it was shared with this
   * account, once that access has ended (#66): the car and every fill-up and
   * submission of it, live and deleted, are **hard**-deleted.
   *
   * No tombstones, on purpose. Those rows are the owner's; this account never
   * had the right to delete them, and a tombstone would try to sync exactly
   * that deletion. Never call this for a car that is yours — `removeVehicle`
   * is the deletion that syncs.
   */
  async forgetVehicle(vehicleId: string): Promise<void> {
    // All of it or none (#85), like `removeVehicle`.
    await atomically(this.repos, async (r) => {
      for (const repo of [r.fillUps, r.pendingFillUps]) {
        // That car's rows, tombstones included, from its index (#87).
        for (const row of await repo.listForVehicleAll(vehicleId)) await repo.purge(row.id);
      }
      await r.vehicles.purge(vehicleId);
    });
  }

  // MARK: Repairing text stored before it was bounded

  /**
   * Shortens live rows whose text is longer than the account accepts, and
   * reports how many it changed (#50).
   *
   * Every door bounds text now, but rows saved before that are on disk, and
   * each one fails the whole upload batch on every sync. Rewriting a row
   * moves its `updatedAt`, so the repaired version is what gets pushed.
   *
   * Called by sync before it builds a push. Idempotent: a row that fits is
   * left alone, so after the first repair this rewrites nothing.
   */
  async repairOversizedText(): Promise<number> {
    const ids = await this.repairOversizedTextIn(await this.snapshot());
    return ids.vehicles.length + ids.fillUps.length + ids.pendingFillUps.length;
  }

  /**
   * The same repair over rows the caller already holds, returning the ids it
   * rewrote (#87): sync has just read every row once, and re-reading them all
   * here was one of the reads it repeated for every remote.
   */
  async repairOversizedTextIn(rows: Snapshot): Promise<Record<Collection, string[]>> {
    return atomically(this.repos, async (r) => ({
      vehicles: await this.repair(r.vehicles, rows.vehicles, boundVehicleText),
      fillUps: await this.repair(r.fillUps, rows.fillUps, boundFillUpText),
      pendingFillUps: await this.repair(r.pendingFillUps, rows.pendingFillUps, boundPendingText),
    }));
  }

  /**
   * The rows held only say **which** need repairing. Each is re-read, inside
   * the transaction, and repaired as it is now (#85): sync read them before
   * it pulled, and repairing that copy wrote it back over any edit saved since.
   */
  private async repair<T extends SyncFields>(
    repo: Repository<T>,
    rows: readonly T[],
    bound: (row: T) => T,
  ): Promise<string[]> {
    // Live rows only, as before: a tombstone carries no text to shorten.
    const tooLong = (row: T): boolean => row.deletedAt === null && bound(row) !== row;
    const candidates = rows.filter(tooLong).map((row) => row.id);
    if (candidates.length === 0) return [];
    const repaired = (await repo.getMany(candidates))
      .filter(tooLong)
      .map((row) => ({ ...bound(row), updatedAt: this.clock.now() }));
    await repo.putMany(repaired);
    return repaired.map((row) => row.id);
  }

  /**
   * Re-stamps rows with the store's clock, unchanged otherwise — deleted rows
   * included. Sync uses it when this device's version of a row wins a tie
   * with the account's (see `tieWinner`): a newer stamp is what gets it sent,
   * and what makes every other device take it.
   */
  async restamp(collection: 'vehicles' | 'fillUps' | 'pendingFillUps', ids: readonly string[]): Promise<void> {
    // Read and re-stamped in one transaction (#85).
    await atomically(this.repos, async (r) => {
      const repo = r[collection] as Repository<SyncFields>;
      // By id, deleted rows included, in one read (#87) — it used to scan
      // every tombstone once per id.
      const rows = await repo.getMany(ids);
      // Strictly newer than it was, whatever clock this store was given:
      // a re-stamp that ties again settles nothing.
      await repo.putMany(rows.map((row) => ({ ...row, updatedAt: Math.max(this.clock.now(), row.updatedAt + 1) })));
    });
  }
}
