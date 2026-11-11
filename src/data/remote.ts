/**
 * The remote half of persistence, as two methods.
 *
 * Deliberately the same minimalism as `Repository`: pull what changed since a
 * cursor (everything, the first time — #52), push what changed. No query
 * language, no realtime subscription, no conflict callback — the conflict rule
 * already exists (`shouldReplace` in `backup.ts`) and a second one would be a
 * second source of truth.
 *
 * The Firebase implementation lives in `firebase/remoteStore.ts` and is the
 * only file that imports `firebase/firestore`. The tests run against
 * `testing/inMemoryRemote.ts`, which is the proof that `sync.ts` contains no
 * Firestore-shaped assumption.
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
  /**
   * True when an incremental read could not be made — its index is not built
   * yet — and everything was read instead (#89): correct, but every row
   * costs a read, so it is reported rather than left silent.
   */
  readonly indexMissing?: boolean;
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
export function sendableRows<T extends SyncFields>(rows: readonly T[], unsendable: string[]): T[] {
  const sendable: T[] = [];
  for (const row of rows) {
    const vehicleId = (row as { readonly vehicleId?: unknown }).vehicleId;
    const addressable = isStorableId(row.id) && (vehicleId === undefined || isStorableId(vehicleId));
    if (addressable && textProblem(row) === null) sendable.push(row);
    else unsendable.push(row.id);
  }
  return sendable;
}
