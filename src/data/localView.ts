/**
 * This device's rows as sync sees them: read **once**, then kept exact for
 * every write sync itself makes (#87).
 *
 * #52 made the network side of sync incremental, but the local side still read
 * whole tables — every receipt photo included — about seven times per remote:
 * a snapshot before the merge, another before the push, the merge's own
 * lookups, the text repair, and for a member one more snapshot per shared car
 * just to find that car. With three shared cars that was over thirty reads of
 * the fill-ups table per sync, on every focus and every save.
 *
 * Now `syncAll` makes one of these and hands it to every `syncOnce`. It reads
 * every table once, the first time it is asked (so a sync that cannot reach the
 * account reads nothing), and afterwards only ever re-reads **by id**: the rows
 * a merge wrote, the rows a tie re-stamped, the rows the text repair shortened,
 * and drops a forgotten car's rows outright. What sync decides — which rows
 * tied, what to push — is therefore decided on the same data as before.
 *
 * What it does not see is a write made *by the app* while a sync is running:
 * that row is sent by the next sync, which every save already schedules
 * (`afterWrite`). The merge itself never relies on this view — `importBackup`
 * looks up what is stored for each incoming row at the moment it writes.
 */

import type { FillUpRecord, PendingFillUpRecord, Snapshot, SyncFields, VehicleRecord } from './records';
import type { Collection } from './remote';
import type { FuelTrackerStore } from './store';

interface Rows {
  readonly vehicles: Map<string, VehicleRecord>;
  readonly fillUps: Map<string, FillUpRecord>;
  readonly pendingFillUps: Map<string, PendingFillUpRecord>;
}

export class LocalView {
  private loaded: Promise<Rows> | null = null;

  constructor(private readonly store: FuelTrackerStore) {}

  private rows(): Promise<Rows> {
    this.loaded ??= this.store.exportSnapshot().then((snapshot) => ({
      vehicles: byId(snapshot.vehicles),
      fillUps: byId(snapshot.fillUps),
      pendingFillUps: byId(snapshot.pendingFillUps),
    }));
    return this.loaded;
  }

  /** Every row, tombstones included, as this view now holds them. */
  async snapshot(): Promise<Snapshot> {
    const rows = await this.rows();
    return {
      vehicles: [...rows.vehicles.values()],
      fillUps: [...rows.fillUps.values()],
      pendingFillUps: [...rows.pendingFillUps.values()],
    };
  }

  /** A vehicle in any state, live or tombstoned, or undefined. */
  async vehicle(id: string): Promise<VehicleRecord | undefined> {
    return (await this.rows()).vehicles.get(id);
  }

  /**
   * Re-reads these rows by id, after sync has written them. An id no longer
   * stored is dropped. Costs nothing before the first read, since the first
   * read will see the write anyway.
   */
  async refresh(collection: Collection, ids: readonly string[]): Promise<void> {
    if (ids.length === 0 || this.loaded === null) return;
    const rows = await this.rows();
    const fresh = await readById(this.store, collection, ids);
    const map = rows[collection] as Map<string, SyncFields>;
    for (const id of ids) map.delete(id);
    for (const row of fresh) map.set(row.id, row);
  }

  /** After `forgetVehicle`: the car and every row of it are gone from storage. */
  async forgetVehicle(vehicleId: string): Promise<void> {
    if (this.loaded === null) return;
    const rows = await this.rows();
    rows.vehicles.delete(vehicleId);
    for (const collection of ['fillUps', 'pendingFillUps'] as const) {
      const map = rows[collection] as Map<string, { readonly vehicleId: string }>;
      for (const [id, row] of map) if (row.vehicleId === vehicleId) map.delete(id);
    }
  }
}

function byId<T extends SyncFields>(rows: readonly T[]): Map<string, T> {
  return new Map(rows.map((row) => [row.id, row]));
}

function readById(store: FuelTrackerStore, collection: Collection, ids: readonly string[]): Promise<SyncFields[]> {
  switch (collection) {
    case 'vehicles':
      return store.rowsById('vehicles', ids);
    case 'fillUps':
      return store.rowsById('fillUps', ids);
    case 'pendingFillUps':
      return store.rowsById('pendingFillUps', ids);
  }
}
