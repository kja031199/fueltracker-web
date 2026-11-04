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

import type { ImportSummary } from './backup';
import type { FillUpRecord, Snapshot } from './records';
import { SCHEMA_VERSION } from './records';
import { validateSnapshot } from './recordValidation';
import type { Collection, PullCursor, PushSummary, RawSnapshot, RemoteStore } from './remote';
import { sendableRows } from './remote';
import type { FuelTrackerStore } from './store';
import type { MonotonicClock } from './syncClock';
import { sharedSyncClock } from './syncClock';
import {
  InMemorySyncState,
  SYNC_CURSOR_VERSION,
  usableCursor,
  type SyncCursor,
  type SyncStateStore,
} from './syncState';

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
  /**
   * Ids of local rows the account cannot address, so they were left out of the
   * push rather than taking it down with them (#26).
   *
   * Reported because the consequence is specific and was otherwise invisible:
   * those rows stay on this device only, and the failure used to present as
   * the ordinary "not uploaded yet" — forever, for every row, not just the
   * broken one.
   */
  readonly unsendable: readonly string[];
  /**
   * Local rows whose text was longer than the account accepts, shortened
   * before this push (#50). Saved before text was bounded at every door; each
   * one used to fail the whole upload batch on every sync.
   */
  readonly repaired: number;
  readonly at: number;
}

/**
 * Why a sync failed, which decides what the reader should do about it.
 *
 * - `unreachable` — offline, a flaky network, the service down. The ordinary
 *   condition of an offline-first app; it fixes itself and there is nothing to
 *   do.
 * - `refused` — the security rules said no. It will **never** fix itself, and
 *   since the allowlist in #27 it is routine rather than a bug: it is what a
 *   signed-in account that is not on the list sees.
 *
 * - `rejected` — the rules refused an *upload*, after the pull worked (#50).
 *   A pull succeeding proves the account is allowed, so this is about the
 *   data, not the person, and the app stays open. Before this it was reported
 *   as `refused`: one over-long field put an allowed owner on the no-access
 *   screen, which hides the very row they would need to fix.
 *
 * Reporting both as "could not reach your account" named the wrong one and
 * sent the one person who could act on it to check their wifi (#40).
 */
export type SyncFailureKind = 'unreachable' | 'refused' | 'rejected';

export type SyncResult =
  | { readonly ok: true; readonly outcome: SyncOutcome }
  | { readonly ok: false; readonly kind: SyncFailureKind; readonly reason: string };

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
 * The rule: an incoming row never *removes* a receipt, it only adds one —
 * **except for a tombstone**, which is the one case where losing the photo is
 * the entire intention. A tombstone now carries no receipt by design
 * (`tombstone.ts`, #25), and the local copy of that row still has one until it
 * is scrubbed, so without this exception a deletion arriving from another
 * device would put the photograph straight back onto the row that was deleted
 * to be rid of it.
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
    if (row.deletedAt !== null) return row;
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
/**
 * Whether the account refused us, as opposed to being out of reach.
 *
 * Checked **structurally** rather than with `instanceof FirestoreError`:
 * importing that would pull the Firebase SDK into this file and break
 * invariant 6, which is what keeps the suite runnable with no SDK and no
 * emulator. The cost is that a future remote has to use the same code; the
 * benefit is that every test of this behaviour runs offline.
 *
 * `unauthenticated` is deliberately *not* treated as a refusal. The SDK
 * refreshes tokens on its own, and a session that is genuinely gone arrives
 * through `onAuthStateChanged`, which puts the app on the sign-in screen — so
 * it is not a thing a sync message has to explain.
 */
export function isRefusal(cause: unknown): boolean {
  if (typeof cause !== 'object' || cause === null) return false;
  return (cause as { code?: unknown }).code === 'permission-denied';
}

/**
 * The message a refused reader needs, which is not "check your connection".
 *
 * Names the one actionable fact: the account id, and who to send it to. It
 * serves the owner too — a rules deploy that refuses its own author reads as
 * this rather than as a network fault.
 */
const REFUSED =
  'This account does not have access to this FuelTracker, so nothing is syncing. ' +
  'Send your account id — Settings → Account — to whoever runs this copy.';

/**
 * A refused upload from an account that is allowed (#50). Says that nothing
 * is lost, because nothing is: every change is still in this browser.
 */
const REJECTED =
  'Your account would not accept some changes, so they are saved on this device but not ' +
  'uploaded. Everything else keeps working; exporting a backup keeps a copy safe meanwhile.';

function failure(cause: unknown, fallback: string): SyncResult {
  if (isRefusal(cause)) return { ok: false, kind: 'refused', reason: REFUSED };
  return { ok: false, kind: 'unreachable', reason: describe(cause, fallback) };
}

/**
 * Which local rows belong to the remote being synced (#66). An account's own
 * sync must not push a car that was shared *with* it — that would copy the
 * owner's car into the member's own account — and a shared car's sync must
 * push only that car's fill-ups. `true` means "this remote's row". Without a
 * scope, every row is, as before sharing existed.
 */
export type RowScope = (
  collection: Collection,
  row: { readonly id: string; readonly vehicleId?: string },
) => boolean;

export interface SyncOptions {
  readonly scope?: RowScope;
}

export async function syncOnce(
  store: FuelTrackerStore,
  remote: RemoteStore,
  clock: MonotonicClock = sharedSyncClock,
  state: SyncStateStore = new InMemorySyncState(),
  options: SyncOptions = {},
): Promise<SyncResult> {
  const inScope: RowScope = options.scope ?? ((): boolean => true);
  // Where the last sync left off (#52). No usable cursor — a first sync, a
  // different build, a damaged record, or a week since the last full read —
  // means reading everything, which is what every sync did before.
  let saved: SyncCursor | null = null;
  try {
    saved = await state.load();
  } catch {
    saved = null;
  }
  // Wall time, not the merge clock: that one jumps ahead after observing a
  // fast device's rows, so a full read stamped with it would look like it
  // happened in the future to the fresh clock after a reload, and every reload
  // would fall back to a full read. Mutation testing caught exactly that.
  const cursor = usableCursor(saved, clock.wall()) ? saved : null;

  let raw: RawSnapshot;
  try {
    raw = await remote.pull(cursor === null ? null : cursor.highWater);
  } catch (cause) {
    return failure(cause, 'Could not reach your account.');
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
  // What the account holds, as far as this device knows: the versions from
  // earlier syncs, overlaid with what this pull just returned. After a full
  // read it is exactly the account's contents, which is what every sync used
  // to compare against.
  // A collection read in full replaces what was known about it, so a document
  // that has disappeared from the account stops being "known" and is sent again.
  const known: Record<string, number> = {};
  if (cursor !== null) {
    for (const [key, at] of Object.entries(cursor.known)) {
      const name = key.slice(0, key.indexOf('/')) as Collection;
      if (cursor.highWater[name] !== null && cursor.highWater[name] !== undefined) known[key] = at;
    }
  }
  for (const [name, rows] of [
    ['vehicles', remoteSnapshot.vehicles],
    ['fillUps', remoteSnapshot.fillUps],
    ['pendingFillUps', remoteSnapshot.pendingFillUps],
  ] as const) {
    for (const row of rows) known[keyOf(name, row.id)] = row.updatedAt;
  }

  // Observed from **everything known**, not only from what was just pulled.
  // An incremental pull returns only changes, and the clock's floor is not
  // kept across reloads: without the known versions a reloaded device would
  // forget a fast device's timestamps, and its next edit would lose to them.
  clock.clearRefusals();
  for (const at of Object.values(known)) clock.observe(at);
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

  // Rows an older build stored with text longer than the account accepts are
  // shortened before the push is built, or each one fails the whole batch on
  // every sync (#50). After the clock has observed the account, so the repair
  // is stamped newer than anything there.
  const repaired = await store.repairOversizedText();

  // The pull is in: remember how far it got, even if the push below fails.
  // Only versions the account confirmed are recorded, so an unsent change
  // stays newer than what is known and is retried next time.
  const highWater = advance(cursor, raw.highWater);
  const fullPulledAt = cursor === null ? clock.wall() : cursor.fullPulledAt;
  await persist(state, { highWater, known, fullPulledAt });

  const localAfter = await store.exportSnapshot();
  // Anything with an id the account cannot address is held back here, by name,
  // rather than being handed to a batch it would abort.
  const unsendable: string[] = [];
  // Only this remote's rows (#66): see `RowScope`.
  const outgoing: Snapshot = {
    vehicles: sendableRows(
      newerThanKnown('vehicles', localAfter.vehicles, known).filter((row) => inScope('vehicles', row)),
      unsendable,
    ),
    fillUps: sendableRows(
      newerThanKnown('fillUps', localAfter.fillUps, known).filter((row) => inScope('fillUps', row)),
      unsendable,
    ),
    pendingFillUps: sendableRows(
      newerThanKnown('pendingFillUps', localAfter.pendingFillUps, known).filter((row) =>
        inScope('pendingFillUps', row),
      ),
      unsendable,
    ),
  };

  let pushed: PushSummary;
  try {
    pushed = await remote.push(outgoing);
  } catch (cause) {
    // The pull worked, so a refusal here is about the data, not the account.
    if (isRefusal(cause)) return { ok: false, kind: 'rejected', reason: REJECTED };
    return failure(cause, 'Changes are saved here but not uploaded yet.');
  }

  // Nothing is recorded about what was just sent: the server stamped it, so
  // the next pull returns it, and that is when its version becomes known. A
  // push that half-failed (one batch of several) is therefore never mistaken
  // for one that landed.

  return {
    ok: true,
    outcome: {
      pulled,
      pushed,
      skippedNewerSchema,
      invalid,
      unbeatable,
      unsendable,
      repaired,
      at: clock.now(),
    },
  };
}

function describe(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message !== '' ? `${fallback} (${cause.message})` : fallback;
}

function keyOf(collection: Collection, id: string): string {
  return `${collection}/${id}`;
}

/** Local rows newer than the version the account is known to hold. */
function newerThanKnown<T extends { readonly id: string; readonly updatedAt: number }>(
  collection: Collection,
  rows: readonly T[],
  known: Readonly<Record<string, number>>,
): T[] {
  return rows.filter((row) => {
    const held = known[keyOf(collection, row.id)];
    return held === undefined || row.updatedAt > held;
  });
}

/**
 * The cursor after a pull: each collection moves to the newest stamp just
 * read, and never backwards. After a full read, a collection whose documents
 * carried no stamp at all goes to 0 — "everything unstamped has been seen" —
 * because every write since the rules change is stamped, so anything newer
 * will be.
 */
function advance(previous: SyncCursor | null, read: PullCursor | undefined): PullCursor {
  const next = (name: Collection): number | null => {
    const before = previous?.highWater[name] ?? null;
    const seen = read?.[name] ?? null;
    // A remote that does not stamp at all keeps every read a full one.
    if (read === undefined) return null;
    if (seen === null) return before ?? 0;
    return before === null ? seen : Math.max(before, seen);
  };
  return { vehicles: next('vehicles'), fillUps: next('fillUps'), pendingFillUps: next('pendingFillUps') };
}

/**
 * Saves the cursor. A failure to save costs a full read next time, never data,
 * so it is not allowed to fail the sync.
 */
async function persist(
  state: SyncStateStore,
  parts: { highWater: PullCursor; known: Record<string, number>; fullPulledAt: number },
): Promise<void> {
  try {
    await state.save({
      version: SYNC_CURSOR_VERSION,
      schemaVersion: SCHEMA_VERSION,
      highWater: parts.highWater,
      known: { ...parts.known },
      fullPulledAt: parts.fullPulledAt,
    });
  } catch {
    // Storage refused; the next sync starts from a full read.
  }
}
