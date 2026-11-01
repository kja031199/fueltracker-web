/**
 * Reconciling local storage with the account, in one pass.
 *
 * ## This file is deliberately small, because the hard part was already written
 *
 * `backup.ts` merges a snapshot into storage by matching ids and letting the
 * newer `updatedAt` win, and its own comment says that rule is "the same rule
 * sync will use". It was not aspirational: `importBackup` **is** the pull half
 * of sync, and `exportSnapshot` is the push half. So this module wires two
 * tested functions together rather than introducing a second, subtly different
 * reconciliation.
 *
 * Reusing it buys one thing that matters more than the saved lines: **every
 * fill-up arriving from the network passes the `makeFuelEntryDraft` gate**,
 * because `importBackup` validates each row it writes. Remote data is untrusted
 * input in exactly the way an imported file is — it may have been written by an
 * older build, corrupted in transit, or edited by hand in a console — and a row
 * claiming `NaN` gallons is rejected and counted rather than quietly poisoning
 * every statistic derived from it.
 *
 * ## Pull before push
 *
 * Pulling first means the local store ends up at least as new as the remote for
 * every row, so the subsequent push can only move rows forward. Pushing first
 * would upload a stale row over a newer remote one whenever two devices had
 * both changed, and last-write-wins would then settle on the wrong winner — the
 * one that happened to sync second, not the one edited later.
 */

import type { BackupSnapshot } from '../domain/backupFormat';
import type { ImportSummary } from './backup';
import type { FillUpRecord } from './records';
import { SCHEMA_VERSION } from './records';
import { validateSnapshot } from './recordValidation';
import type { PushSummary, RawSnapshot, RemoteStore } from './remote';
import { rowsToPush } from './remote';
import type { FuelTrackerStore } from './store';
import type { MonotonicClock } from './syncClock';
import { sharedSyncClock } from './syncClock';

export interface SyncOutcome {
  readonly pulled: ImportSummary;
  readonly pushed: PushSummary;
  /** Rows the remote held in a newer schema than this build understands. */
  readonly skippedNewerSchema: number;
  /**
   * Documents in the account that were not the shape they claimed, and were
   * refused before anything downstream could treat them as records.
   */
  readonly invalid: readonly string[];
  /**
   * Rows dated so far in the future that this device will not raise its clock
   * to match them — so they keep winning every merge, and edits made here to
   * those rows will not stick. Surfaced because losing to a row we cannot
   * outbid is bad, and losing to it silently is worse.
   */
  readonly unbeatable: number;
  readonly at: number;
}

export type SyncResult =
  | { readonly ok: true; readonly outcome: SyncOutcome }
  | { readonly ok: false; readonly reason: string };

/**
 * Drops rows this build cannot read.
 *
 * A row whose `schemaVersion` exceeds what we know about was written by a newer
 * version of the app, possibly with fields this one would discard. Skipping it
 * leaves it intact in the account for the newer build to keep using; reading it
 * optimistically and pushing it back is how a downgrade silently strips data.
 */
export function partitionBySchema<T extends { readonly schemaVersion: number }>(
  rows: readonly T[],
): { readonly readable: T[]; readonly tooNew: T[] } {
  const readable: T[] = [];
  const tooNew: T[] = [];
  for (const row of rows) {
    if (row.schemaVersion > SCHEMA_VERSION) tooNew.push(row);
    else readable.push(row);
  }
  return { readable, tooNew };
}

/**
 * Carries a local receipt photo onto an incoming row that has none.
 *
 * This closes a narrow but real way to lose a photo. A receipt too large for
 * one document is pushed with its bytes omitted, so the account holds that row
 * *without* the image. If a second device then edits the fill-up, its row
 * becomes newer and syncs back — and a plain merge would overwrite the original
 * device's copy with the photoless version, destroying the only remaining copy
 * of the image.
 *
 * The rule: an incoming row never *removes* a receipt, it only adds one. A
 * deliberate deletion of a fill-up travels as a tombstone, so nothing here
 * blocks a real delete.
 *
 * It lives in sync rather than in `importBackup` because the file-import path
 * has its own tested behaviour, and widening that behaviour to serve this case
 * would change what a restore does.
 */
export function preserveLocalReceipts(
  incoming: readonly FillUpRecord[],
  local: readonly FillUpRecord[],
): FillUpRecord[] {
  const localById = new Map(local.map((row) => [row.id, row]));
  return incoming.map((row) => {
    if (row.receiptImageData !== null) return row;
    const existing = localById.get(row.id);
    if (existing === undefined || existing.receiptImageData === null) return row;
    return { ...row, receiptImageData: existing.receiptImageData };
  });
}

/**
 * One full reconciliation: pull, merge, then push what is newer locally.
 *
 * Never throws. A failure to reach the account is an ordinary condition for an
 * offline-first app, and the caller's job is to show "not synced yet", not to
 * crash the screen someone is typing into. A failed **pull** leaves local
 * storage untouched; a failed **push** leaves the pulled merge in place, which
 * is correct — the data arrived, only the upload did not.
 */
export async function syncOnce(
  store: FuelTrackerStore,
  remote: RemoteStore,
  clock: MonotonicClock = sharedSyncClock,
): Promise<SyncResult> {
  let raw: RawSnapshot;
  try {
    raw = await remote.pull();
  } catch (cause) {
    return { ok: false, reason: describe(cause, 'Could not reach your account.') };
  }

  // **Shape first, before anything else looks at it.** The account's contents
  // are untrusted input in exactly the way an imported file is, and the one
  // guarantee that mattered — that a fill-up's numbers are finite and positive
  // — only covered numbers. A document with a string `date` or an object
  // `vehicleId` used to flow straight into the statistics layer.
  const { snapshot: remoteSnapshot, rejected: invalid } = validateSnapshot(raw);

  // **Observed before anything is written.** Merges are last-write-wins on
  // `updatedAt`, so a device whose clock is ahead would otherwise beat every
  // edit made here — silently, because losing a merge is not an error. Raising
  // this device's floor above everything it has seen makes the next local write
  // strictly newer, which is what turns "last write" back into "last edit".
  clock.clearRefusals();
  for (const row of [
    ...remoteSnapshot.vehicles,
    ...remoteSnapshot.fillUps,
    ...remoteSnapshot.pendingFillUps,
  ]) {
    clock.observe(row.updatedAt);
  }
  const unbeatable = clock.refusedCount;

  const vehicles = partitionBySchema(remoteSnapshot.vehicles);
  const fillUps = partitionBySchema(remoteSnapshot.fillUps);
  const pending = partitionBySchema(remoteSnapshot.pendingFillUps);
  const skippedNewerSchema =
    vehicles.tooNew.length + fillUps.tooNew.length + pending.tooNew.length;

  const localBefore = await store.exportSnapshot();
  const pulled = await store.importBackup({
    vehicles: vehicles.readable,
    fillUps: preserveLocalReceipts(fillUps.readable, localBefore.fillUps),
    pendingFillUps: pending.readable,
  });

  const localAfter = await store.exportSnapshot();
  const outgoing: BackupSnapshot = {
    vehicles: rowsToPush(localAfter.vehicles, remoteSnapshot.vehicles),
    fillUps: rowsToPush(localAfter.fillUps, remoteSnapshot.fillUps),
    pendingFillUps: rowsToPush(localAfter.pendingFillUps, remoteSnapshot.pendingFillUps),
  };

  let pushed: PushSummary;
  try {
    pushed = await remote.push(outgoing);
  } catch (cause) {
    return { ok: false, reason: describe(cause, 'Changes are saved here but not uploaded yet.') };
  }

  return {
    ok: true,
    outcome: { pulled, pushed, skippedNewerSchema, invalid, unbeatable, at: clock.now() },
  };
}

function describe(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message !== '' ? `${fallback} (${cause.message})` : fallback;
}
