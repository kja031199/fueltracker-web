/**
 * The remote half of persistence, as two methods.
 *
 * Deliberately the same minimalism as `Repository`: pull everything, push what
 * changed. No query language, no realtime subscription, no conflict callback —
 * the conflict rule already exists (`shouldReplace` in `backup.ts`) and a
 * second one would be a second source of truth.
 *
 * `InMemoryRemoteStore` is what the sync tests run against, and it is not
 * busywork: it is the proof that `sync.ts` contains no Firestore-shaped
 * assumption. The Firebase implementation lives in `firebase/remoteStore.ts`
 * and is the only file that imports `firebase/firestore`.
 */

import type { SyncFields, Snapshot } from './records';
import { isStorableId } from './recordId';
import { textProblem } from './recordText';

export interface PushSummary {
  /** Documents written. */
  readonly written: number;
  /**
   * Fill-ups pushed **without** their receipt photo because the image exceeded
   * what one document can hold. The row syncs; the photo stays on the device
   * that has it. Surfaced rather than swallowed — see `MAX_SYNCED_RECEIPT_BYTES`.
   */
  readonly receiptsOmitted: number;
}

/**
 * What a pull returns: documents, not records.
 *
 * Typed as `unknown[]` on purpose. The account's contents may have been written
 * by a different build of this app, half-written, or edited by hand in the
 * Firebase console — so a remote implementation is not in a position to promise
 * that what it read is a `VehicleRecord`. Saying `Snapshot` here would be
 * the lie that lets an unchecked document reach the statistics layer, and
 * putting the honest type in the interface is what forces `syncOnce` to
 * validate it. Every implementation gets that for free, including future ones.
 */
export interface RawSnapshot {
  readonly vehicles: readonly unknown[];
  readonly fillUps: readonly unknown[];
  readonly pendingFillUps: readonly unknown[];
  /**
   * Per collection, the newest server stamp among the documents just read —
   * the cursor for the next incremental read (#52). `null` for a collection
   * whose documents carried no stamp. Absent from a remote that does not stamp
   * at all, which sync then reads in full every time, as before.
   */
  readonly highWater?: PullCursor;
}

export type Collection = 'vehicles' | 'fillUps' | 'pendingFillUps';

/** Per collection: read only documents stamped after this, or all of them when `null`. */
export type PullCursor = Readonly<Record<Collection, number | null>>;

export interface RemoteStore {
  /**
   * What the account holds, tombstones included and unvalidated: everything
   * when `since` is absent or `null`, otherwise only the documents each
   * collection has had stamped since its mark (#52).
   */
  pull(since?: PullCursor | null): Promise<RawSnapshot>;
  /** Writes these rows, replacing by id. */
  push(snapshot: Snapshot): Promise<PushSummary>;
}

/** An empty snapshot, for a fresh account or a failed pull. */
export function emptySnapshot(): Snapshot {
  return { vehicles: [], fillUps: [], pendingFillUps: [] };
}

/**
 * A `RemoteStore` backed by plain `Map`s.
 *
 * Replaces by id and keeps tombstones, exactly as Firestore does, so a test
 * that pushes then pulls sees what the real thing would return.
 *
 * It also stamps like Firestore (#52): every pushed row gets a server time,
 * strictly increasing per push, and a pull with a cursor returns only rows
 * stamped after it. A **seeded** row has no stamp — it stands for a document
 * written before stamps existed — so only a full read returns it, which is
 * exactly the real migration case.
 */
export class InMemoryRemoteStore implements RemoteStore {
  private readonly vehicles = new Map<string, Snapshot['vehicles'][number]>();
  private readonly fillUps = new Map<string, Snapshot['fillUps'][number]>();
  private readonly pendingFillUps = new Map<string, Snapshot['pendingFillUps'][number]>();
  /** `collection/id` → the server time of the last push that wrote it. */
  private readonly stamps = new Map<string, number>();
  private serverTime = 0;

  /** Set to make `pull()` reject, standing in for being offline. */
  failPull = false;
  /** Set to make `push()` reject, standing in for a write that is refused. */
  failPush = false;
  /** Bound above which a receipt is dropped, mirroring the document cap. */
  receiptByteLimit = Number.POSITIVE_INFINITY;
  /** Every pull: the cursor it was given and how many rows it returned. */
  readonly pullLog: { readonly since: PullCursor | null; readonly rows: number }[] = [];

  constructor(seed: Snapshot = emptySnapshot()) {
    for (const row of seed.vehicles) this.vehicles.set(row.id, row);
    for (const row of seed.fillUps) this.fillUps.set(row.id, row);
    for (const row of seed.pendingFillUps) this.pendingFillUps.set(row.id, row);
  }

  /** Whether this tree holds a vehicle document with that id, live or a tombstone. */
  hasVehicle(id: string): boolean {
    return this.vehicles.has(id);
  }

  async pull(since: PullCursor | null = null): Promise<RawSnapshot> {
    if (this.failPull) throw new Error('offline');
    const vehicles = this.read('vehicles', this.vehicles, since);
    const fillUps = this.read('fillUps', this.fillUps, since);
    const pendingFillUps = this.read('pendingFillUps', this.pendingFillUps, since);
    this.pullLog.push({
      since,
      rows: vehicles.rows.length + fillUps.rows.length + pendingFillUps.rows.length,
    });
    return {
      vehicles: vehicles.rows,
      fillUps: fillUps.rows,
      pendingFillUps: pendingFillUps.rows,
      highWater: {
        vehicles: vehicles.highWater,
        fillUps: fillUps.highWater,
        pendingFillUps: pendingFillUps.highWater,
      },
    };
  }

  async push(snapshot: Snapshot): Promise<PushSummary> {
    if (this.failPush) throw new Error('write refused');
    // One batch, one commit time — as a Firestore `writeBatch` stamps it.
    const at = ++this.serverTime;
    let written = 0;
    let receiptsOmitted = 0;
    for (const row of snapshot.vehicles) {
      this.vehicles.set(row.id, row);
      this.stamps.set(`vehicles/${row.id}`, at);
      written += 1;
    }
    for (const row of snapshot.fillUps) {
      const bytes = row.receiptImageData;
      if (bytes !== null && bytes.byteLength > this.receiptByteLimit) {
        this.fillUps.set(row.id, { ...row, receiptImageData: null });
        receiptsOmitted += 1;
      } else {
        this.fillUps.set(row.id, row);
      }
      this.stamps.set(`fillUps/${row.id}`, at);
      written += 1;
    }
    for (const row of snapshot.pendingFillUps) {
      this.pendingFillUps.set(row.id, row);
      this.stamps.set(`pendingFillUps/${row.id}`, at);
      written += 1;
    }
    return { written, receiptsOmitted };
  }

  /** Deletes a document outright, as a hand edit in the console would. */
  forget(collection: Collection, id: string): void {
    this[collection].delete(id);
    this.stamps.delete(`${collection}/${id}`);
  }

  private read<T extends SyncFields>(
    name: Collection,
    rows: Map<string, T>,
    since: PullCursor | null,
  ): { rows: T[]; highWater: number | null } {
    const mark = since === null ? null : since[name];
    let highWater: number | null = null;
    const out: T[] = [];
    for (const row of rows.values()) {
      const stamp = this.stamps.get(`${name}/${row.id}`);
      if (mark !== null && (stamp === undefined || stamp <= mark)) continue;
      out.push(row);
      if (stamp !== undefined) highWater = Math.max(highWater ?? stamp, stamp);
    }
    return { rows: out, highWater };
  }
}

/** Rows the remote side is missing or holds an older version of. */
/**
 * Keeps the rows the account can actually address, and names the ones it cannot.
 *
 * A row whose id is not a storable document name cannot be uploaded, and
 * attempting it does not fail politely: the SDK throws, or the server refuses,
 * and the whole `writeBatch` goes with it — so one such row stops *everything*
 * uploading, on every sync, forever (#26). Validation now refuses an id like
 * that at every door, but a row stored before that cannot be allowed to hold
 * an account hostage.
 *
 * The same holds for anything else the rules would refuse a row for (#50): a
 * vehicle id the account cannot store, or text over its limit. Text is bounded
 * at every door and repaired before a push, so this should find nothing —
 * it is the backstop that keeps one row from costing the whole upload if
 * something ever slips past.
 *
 * Declining to send a row is as far as this goes. The row stays in local
 * storage: refusing to upload somebody's data is not a licence to delete it,
 * and `SyncOutcome.unsendable` is how they get told instead.
 */
export function sendableRows<T extends SyncFields>(
  rows: readonly T[],
  unsendable: string[],
): T[] {
  const sendable: T[] = [];
  for (const row of rows) {
    const vehicleId = (row as { readonly vehicleId?: unknown }).vehicleId;
    const addressable =
      isStorableId(row.id) && (vehicleId === undefined || isStorableId(vehicleId));
    if (addressable && textProblem(row) === null) sendable.push(row);
    else unsendable.push(row.id);
  }
  return sendable;
}

export function rowsToPush<T extends SyncFields>(
  local: readonly T[],
  remote: readonly T[],
): T[] {
  const remoteById = new Map(remote.map((row) => [row.id, row]));
  return local.filter((row) => {
    const existing = remoteById.get(row.id);
    // Strictly greater, the same comparison `shouldReplace` uses. Equal means
    // both sides already agree, and re-writing it would spend a quota write to
    // change nothing.
    return existing === undefined || row.updatedAt > existing.updatedAt;
  });
}
