/**
 * Taking a snapshot of everything, and merging one back in.
 *
 * The serialisation lives in `domain/backupFormat.ts`; this is the half that
 * talks to storage and decides what happens when a file meets data that is
 * already there.
 */

import { makeFuelEntryDraft } from '../domain/fuelEntryDraft';
import type { BackupSnapshot } from '../domain/backupFormat';
import type { FillUpRecord, PendingFillUpRecord, SyncFields, VehicleRecord } from './records';
import type { Repositories } from './store';

/**
 * Everything in storage, **including tombstones**.
 *
 * This is why it reads the repositories rather than the store's own accessors:
 * `vehicles()` and `fillUps()` return live rows only, and a backup built on
 * those would **resurrect deleted entries** when restored — the row comes back
 * with no record that it was ever deleted. `listDeleted` has had no reader
 * until now; this is the one it was written for.
 */
export async function exportSnapshot(repos: Repositories): Promise<BackupSnapshot> {
  const [vehicles, deletedVehicles] = await Promise.all([
    repos.vehicles.list(),
    repos.vehicles.listDeleted(),
  ]);
  const [fillUps, deletedFillUps] = await Promise.all([
    repos.fillUps.list(),
    repos.fillUps.listDeleted(),
  ]);
  const [pending, deletedPending] = await Promise.all([
    repos.pendingFillUps.list(),
    repos.pendingFillUps.listDeleted(),
  ]);
  return {
    vehicles: [...vehicles, ...deletedVehicles],
    fillUps: [...fillUps, ...deletedFillUps],
    pendingFillUps: [...pending, ...deletedPending],
  };
}

export interface ImportSummary {
  readonly vehiclesWritten: number;
  readonly fillUpsWritten: number;
  readonly pendingWritten: number;
  /** Rows the file contained but storage already had a newer version of. */
  readonly skippedOlder: number;
  /** Rows that failed validation, with a reason each. */
  readonly rejected: readonly string[];
}

/**
 * True when the incoming row should replace what is stored.
 *
 * **Last-write-wins on `updatedAt`**, which is the same rule sync will use —
 * so this is the reconciliation logic being exercised early rather than a
 * throwaway. It also makes re-importing the same file a no-op instead of a way
 * to duplicate an entire history.
 */
function shouldReplace(incoming: SyncFields, existing: SyncFields | undefined): boolean {
  if (existing === undefined) return true;
  return incoming.updatedAt > existing.updatedAt;
}

/**
 * Merges a parsed backup into storage.
 *
 * Two rules do the work:
 *
 * - **Merge, never replace.** Restoring a backup must not destroy edits made
 *   since it was taken, so rows are matched by id and the newer `updatedAt`
 *   wins. Nothing is deleted just because the file does not mention it.
 * - **Every fill-up passes the draft gate.** An import file is a new input
 *   source and an untrusted one — hand-edited, exported by another app, or
 *   corrupted — so it builds a draft like every other write path. A row that
 *   fails is rejected and counted; it does not abort the import, because one
 *   bad row should not cost someone the other nine hundred.
 *
 * A tombstoned row in the file is written **as a tombstone**, so a deletion
 * travels with the backup instead of being quietly undone.
 */
export async function importBackup(
  repos: Repositories,
  snapshot: BackupSnapshot,
): Promise<ImportSummary> {
  const rejected: string[] = [];
  let skippedOlder = 0;
  let vehiclesWritten = 0;
  let fillUpsWritten = 0;
  let pendingWritten = 0;

  const existingVehicles = new Map<string, VehicleRecord>();
  for (const row of [...(await repos.vehicles.list()), ...(await repos.vehicles.listDeleted())]) {
    existingVehicles.set(row.id, row);
  }
  for (const incoming of snapshot.vehicles) {
    if (!shouldReplace(incoming, existingVehicles.get(incoming.id))) {
      skippedOlder += 1;
      continue;
    }
    await repos.vehicles.put(incoming);
    vehiclesWritten += 1;
  }

  const existingFillUps = new Map<string, FillUpRecord>();
  for (const row of [...(await repos.fillUps.list()), ...(await repos.fillUps.listDeleted())]) {
    existingFillUps.set(row.id, row);
  }
  for (const incoming of snapshot.fillUps) {
    if (!shouldReplace(incoming, existingFillUps.get(incoming.id))) {
      skippedOlder += 1;
      continue;
    }
    // A tombstone carries no usable measurements and does not need to: it is a
    // record that something was deleted, and validating it would reject it.
    if (incoming.deletedAt === null) {
      const draft = makeFuelEntryDraft({
        date: new Date(incoming.date),
        odometer: incoming.odometer,
        gallons: incoming.gallons,
        pricePerGallon: incoming.pricePerGallon,
      });
      if (draft === null) {
        rejected.push(
          `fill-up ${incoming.id}: odometer, volume and price must all be positive numbers`,
        );
        continue;
      }
    }
    await repos.fillUps.put(incoming);
    fillUpsWritten += 1;
  }

  const existingPending = new Map<string, PendingFillUpRecord>();
  for (const row of [
    ...(await repos.pendingFillUps.list()),
    ...(await repos.pendingFillUps.listDeleted()),
  ]) {
    existingPending.set(row.id, row);
  }
  for (const incoming of snapshot.pendingFillUps) {
    if (!shouldReplace(incoming, existingPending.get(incoming.id))) {
      skippedOlder += 1;
      continue;
    }
    // Submissions are re-validated when approved, so a questionable one is
    // allowed to sit in the queue — that is what the queue is for.
    await repos.pendingFillUps.put(incoming);
    pendingWritten += 1;
  }

  return { vehiclesWritten, fillUpsWritten, pendingWritten, skippedOlder, rejected };
}

/** A filename that sorts by date and says what it is. */
export function backupFilename(now: Date = new Date(), extension = 'json'): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `fueltracker-${stamp}.${extension}`;
}
