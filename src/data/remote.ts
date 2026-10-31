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

import type { BackupSnapshot } from '../domain/backupFormat';
import type { SyncFields } from './records';

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

export interface RemoteStore {
  /** Everything the account holds, tombstones included. */
  pull(): Promise<BackupSnapshot>;
  /** Writes these rows, replacing by id. */
  push(snapshot: BackupSnapshot): Promise<PushSummary>;
}

/** An empty snapshot, for a fresh account or a failed pull. */
export function emptySnapshot(): BackupSnapshot {
  return { vehicles: [], fillUps: [], pendingFillUps: [] };
}

/**
 * A `RemoteStore` backed by plain `Map`s.
 *
 * Replaces by id and keeps tombstones, exactly as Firestore does, so a test
 * that pushes then pulls sees what the real thing would return.
 */
export class InMemoryRemoteStore implements RemoteStore {
  private readonly vehicles = new Map<string, BackupSnapshot['vehicles'][number]>();
  private readonly fillUps = new Map<string, BackupSnapshot['fillUps'][number]>();
  private readonly pendingFillUps = new Map<string, BackupSnapshot['pendingFillUps'][number]>();

  /** Set to make `pull()` reject, standing in for being offline. */
  failPull = false;
  /** Set to make `push()` reject, standing in for a write that is refused. */
  failPush = false;
  /** Bound above which a receipt is dropped, mirroring the document cap. */
  receiptByteLimit = Number.POSITIVE_INFINITY;

  constructor(seed: BackupSnapshot = emptySnapshot()) {
    for (const row of seed.vehicles) this.vehicles.set(row.id, row);
    for (const row of seed.fillUps) this.fillUps.set(row.id, row);
    for (const row of seed.pendingFillUps) this.pendingFillUps.set(row.id, row);
  }

  async pull(): Promise<BackupSnapshot> {
    if (this.failPull) throw new Error('offline');
    return {
      vehicles: [...this.vehicles.values()],
      fillUps: [...this.fillUps.values()],
      pendingFillUps: [...this.pendingFillUps.values()],
    };
  }

  async push(snapshot: BackupSnapshot): Promise<PushSummary> {
    if (this.failPush) throw new Error('write refused');
    let written = 0;
    let receiptsOmitted = 0;
    for (const row of snapshot.vehicles) {
      this.vehicles.set(row.id, row);
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
      written += 1;
    }
    for (const row of snapshot.pendingFillUps) {
      this.pendingFillUps.set(row.id, row);
      written += 1;
    }
    return { written, receiptsOmitted };
  }
}

/** Rows the remote side is missing or holds an older version of. */
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
