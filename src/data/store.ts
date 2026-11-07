/**
 * The application's write surface.
 *
 * ## The one rule this file exists to enforce
 *
 * **Every fill-up that reaches storage is built from a `FuelEntryDraft`.** That
 * is invariant 4 of the original architecture, carried over intact: validation
 * lives in exactly one place rather than being re-checked (or forgotten) by
 * each caller. `addFillUp` takes a draft, not loose fields, so there is no
 * signature here that *could* write an unvalidated entry — the repositories
 * below are deliberately not exported for direct fill-up writes.
 *
 * A submission from another person goes through the same gate twice: once when
 * it is submitted, and again when it is approved, because the record could have
 * been altered in between.
 */

import type { FuelEntryDraft } from '../domain/fuelEntryDraft';
import { makeFuelEntryDraft } from '../domain/fuelEntryDraft';
import type { FillUpRecord, PendingFillUpRecord, SyncFields, VehicleRecord, Snapshot } from './records';
import { SCHEMA_VERSION } from './records';
import type { Repository, VehicleScopedRepository } from './repository';
import type { FillUpSummary } from './records';
import { toSummary } from './records';
import type { Tombstoner } from './tombstone';
import { isScrubbed, tombstoneFillUp, tombstonePending, tombstoneVehicle } from './tombstone';
import type { ImportSummary, TieBreak } from './backup';
import type { Submission } from './fillUpLink';
import { exportSnapshot, importBackup } from './backup';
import { atomically } from './atomically';
import { TEXT_LIMITS, boundText } from '../domain/textLimits';
import { boundFillUpText, boundPendingText, boundVehicleText } from './recordText';
import { StaleEdit } from './staleEdit';
import type { Collection } from './remote';

/**
 * Injected rather than read from globals, so tests are deterministic and a
 * future import path can stamp a record's real creation time instead of "now".
 */
export interface StoreClock {
  now(): number;
  newId(): string;
}

export const systemClock: StoreClock = {
  now: () => Date.now(),
  newId: () => crypto.randomUUID(),
};

export interface Repositories {
  readonly vehicles: Repository<VehicleRecord>;
  readonly fillUps: VehicleScopedRepository<FillUpRecord>;
  readonly pendingFillUps: VehicleScopedRepository<PendingFillUpRecord>;
  /**
   * Runs `work` as one transaction over all three tables (#85): every write
   * in it lands or none does, and no other write lands in the middle of it.
   * The store runs each merge and each cascade in one, and decides inside it,
   * against rows read inside it.
   *
   * `work` is handed repositories **bound to the transaction**, and must use
   * those: Dexie's tracking of "the current transaction" does not survive a
   * few `await`s through ordinary async functions, and a write that loses it
   * quietly becomes a write of its own. Those have no `transaction`, so a
   * nested `atomically` just runs.
   *
   * Optional, because only the device's database has transactions:
   * `dexieRepositories` (`db.ts`) always supplies one. Without it — the
   * in-memory repositories of the tests and the demo — `work` simply runs.
   */
  readonly transaction?: <R>(work: (repos: Repositories) => Promise<R>) => Promise<R>;
}

export interface NewVehicle {
  readonly name: string;
  readonly make?: string;
  readonly model?: string;
  readonly year?: number;
}

export class FuelTrackerStore {
  constructor(
    private readonly repos: Repositories,
    private readonly clock: StoreClock = systemClock,
    /**
     * The signed-in account, stamped on each new fill-up as `enteredBy`
     * (#66). `null` where there is no account: tests, the demo, local-only.
     */
    private readonly author: string | null = null,
  ) {}

  // MARK: Vehicles

  async addVehicle(vehicle: NewVehicle): Promise<VehicleRecord> {
    const now = this.clock.now();
    const record: VehicleRecord = {
      id: this.clock.newId(),
      updatedAt: now,
      deletedAt: null,
      schemaVersion: SCHEMA_VERSION,
      // Bounded like a fill-up's text is at the draft gate (#50).
      name: boundText(vehicle.name, TEXT_LIMITS.name),
      make: boundText(vehicle.make ?? '', TEXT_LIMITS.make),
      model: boundText(vehicle.model ?? '', TEXT_LIMITS.model),
      year: vehicle.year ?? new Date(now).getFullYear(),
      createdAt: now,
    };
    await this.repos.vehicles.put(record);
    return record;
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

  async vehicles(): Promise<VehicleRecord[]> {
    const rows = await this.repos.vehicles.list();
    return rows.sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * Tombstones the vehicle, **its fill-ups and its waiting submissions**,
   * mirroring the cascade delete upstream. Done explicitly because a tombstone
   * cannot cascade on its own: orphaned rows would otherwise stay live,
   * invisible in the UI but present in storage and ready to sync back as a
   * vehicle with no owner — and a submission keeps someone else's name and
   * note (#85).
   *
   * All of it or none (#85): it used to write a row at a time, so a closed tab
   * part way left a live car with some of its fill-ups deleted.
   */
  async removeVehicle(vehicleId: string): Promise<void> {
    await atomically(this.repos, async (r) => {
      // That vehicle's rows only, from the index (#53) — not every fill-up.
      const [entries, submissions] = await Promise.all([
        r.fillUps.listForVehicle(vehicleId),
        r.pendingFillUps.listForVehicle(vehicleId),
      ]);
      await r.fillUps.putMany(entries.map((row) => tombstoneFillUp(row, this.clock.now())));
      await r.pendingFillUps.putMany(submissions.map((row) => tombstonePending(row, this.clock.now())));
      const at = this.clock.now();
      await r.vehicles.remove(vehicleId, (row) => tombstoneVehicle(row, at));
    });
  }

  // MARK: Fill-ups — the only write path

  /**
   * Writes a validated draft as a fill-up on `vehicleId`.
   *
   * Takes a draft rather than raw fields on purpose: the type system, not a
   * code review, is what stops an unvalidated entry reaching storage.
   */
  async addFillUp(draft: FuelEntryDraft, vehicleId: string): Promise<FillUpRecord> {
    return this.writeFillUp(this.repos, draft, vehicleId);
  }

  private async writeFillUp(repos: Repositories, draft: FuelEntryDraft, vehicleId: string): Promise<FillUpRecord> {
    const record = { ...this.recordFromDraft(draft, vehicleId, this.clock.newId()), enteredBy: this.author };
    await repos.fillUps.put(record);
    return record;
  }

  /**
   * Replaces an existing fill-up from a draft, keeping its id.
   *
   * Editing runs through the same validation as creating — an edit that would
   * zero the gallons has to fail exactly as a creation would, which it does by
   * never producing a draft in the first place.
   */
  /**
   * Replaces a fill-up's contents, **on the car it is already on** (#83).
   *
   * There is no car parameter, so an edit cannot move a fill-up: it used to
   * take the *selected* car, and a sync that changed the selection while the
   * form was open moved the fill-up silently. Refused with `StaleEdit` —
   * nothing written — when the fill-up has been deleted meanwhile (saving used
   * to write it back as a new row), or its car has.
   */
  async updateFillUp(id: string, draft: FuelEntryDraft): Promise<FillUpRecord> {
    // Checked and written in one transaction (#85), so a deletion synced in
    // between cannot be undone by the save.
    return atomically(this.repos, async (r) => {
      const existing = await r.fillUps.get(id);
      if (existing === undefined) throw new StaleEdit('fill-up-gone');
      if ((await r.vehicles.get(existing.vehicleId)) === undefined) throw new StaleEdit('car-gone');
      // Who entered it does not change because someone else corrected it — and
      // on a shared car the rules refuse an edit that tries.
      const record = { ...this.recordFromDraft(draft, existing.vehicleId, id), enteredBy: existing.enteredBy ?? null };
      await r.fillUps.put(record);
      return record;
    });
  }

  /**
   * Tombstones a fill-up, keeping only what sync needs to reconcile it.
   *
   * The receipt photograph, the notes, the station and the coordinates are
   * **gone**, not hidden — see `tombstone.ts` for why that was not always
   * true. What remains is a record that this id was deleted.
   */
  async removeFillUp(id: string): Promise<void> {
    const at = this.clock.now();
    await this.repos.fillUps.remove(id, (row) => tombstoneFillUp(row, at));
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

  /**
   * How many live fill-ups exist, across every vehicle.
   *
   * Deliberately counts the same rows `fillUps()` would return — live only,
   * tombstones excluded — because the backup reminder compares this against a
   * count recorded at export time. If the two counted differently, the
   * difference alone would drift people into being prompted.
   */
  async fillUpCount(): Promise<number> {
    // From the indexes, reading no rows (#53). It used to read every fill-up of
    // every vehicle — every receipt photo — after every save, to return a number.
    return this.repos.fillUps.countLive();
  }

  /**
   * One vehicle's live fill-ups, newest first, **without their photo bytes**
   * (#53). Read through the `vehicleId` index rather than the whole table. The
   * screens hold these for the session and none of them shows a photo; to edit
   * one, load it whole with `fillUp(id)`.
   */
  async fillUps(vehicleId: string): Promise<FillUpSummary[]> {
    const rows = await this.repos.fillUps.listForVehicle(vehicleId);
    return rows.sort((a, b) => b.date - a.date).map(toSummary);
  }

  /**
   * One whole live fill-up, photo included — what the edit form starts from,
   * so that saving an edit keeps the photo. `undefined` if it is deleted or
   * unknown.
   */
  async fillUp(id: string): Promise<FillUpRecord | undefined> {
    return this.repos.fillUps.get(id);
  }

  // MARK: Pending submissions

  /** Records a submission from someone else. Validated on the way in. */
  async submitFillUp(
    draft: FuelEntryDraft,
    vehicleId: string,
    submitterName: string,
  ): Promise<PendingFillUpRecord> {
    const now = this.clock.now();
    const record: PendingFillUpRecord = {
      id: this.clock.newId(),
      updatedAt: now,
      deletedAt: null,
      schemaVersion: SCHEMA_VERSION,
      vehicleId,
      submittedAt: now,
      submitterName: boundText(submitterName, TEXT_LIMITS.submitterName),
      date: draft.date.getTime(),
      odometer: draft.odometer,
      gallons: draft.gallons,
      pricePerGallon: draft.pricePerGallon,
      isFullTank: draft.isFullTank,
      fuelGrade: draft.fuelGrade,
      station: draft.station,
      notes: draft.notes,
      latitude: draft.latitude,
      longitude: draft.longitude,
      receiptImageData: draft.receiptImageData,
    };
    await this.repos.pendingFillUps.put(record);
    return record;
  }

  /**
   * Queues a submission that arrived by link (#3), under the id the link
   * carried — so opening the same link twice, or after it was approved or
   * rejected, queues nothing (`'duplicate'`). A car that is not here, or was
   * deleted, is `'no-such-car'`. The draft was validated when the link was
   * decoded, and is validated again on approval.
   */
  async receiveSubmission(submission: Submission): Promise<'queued' | 'duplicate' | 'no-such-car'> {
    // Checked and queued in one transaction (#85): the same link opened twice
    // at once queues it once.
    return atomically(this.repos, (r) => this.queueSubmission(r, submission));
  }

  private async queueSubmission(r: Repositories, submission: Submission): Promise<'queued' | 'duplicate' | 'no-such-car'> {
    if ((await r.vehicles.get(submission.vehicleId)) === undefined) return 'no-such-car';
    // Queued, approved or rejected: any row with this id, by key (#87).
    if ((await r.pendingFillUps.getMany([submission.id])).length > 0) return 'duplicate';
    const { draft } = submission;
    await r.pendingFillUps.put({
      id: submission.id,
      updatedAt: this.clock.now(),
      deletedAt: null,
      schemaVersion: SCHEMA_VERSION,
      vehicleId: submission.vehicleId,
      submittedAt: submission.submittedAt,
      submitterName: boundText(submission.submitterName, TEXT_LIMITS.submitterName),
      date: draft.date.getTime(),
      odometer: draft.odometer,
      gallons: draft.gallons,
      pricePerGallon: draft.pricePerGallon,
      isFullTank: draft.isFullTank,
      fuelGrade: draft.fuelGrade,
      station: boundText(draft.station, TEXT_LIMITS.station),
      notes: boundText(draft.notes, TEXT_LIMITS.notes),
      latitude: null,
      longitude: null,
      receiptImageData: null,
    });
    return 'queued';
  }

  async pendingFillUps(): Promise<PendingFillUpRecord[]> {
    const rows = await this.repos.pendingFillUps.list();
    return rows.sort((a, b) => b.submittedAt - a.submittedAt);
  }

  /**
   * Promotes a reviewed submission into a real fill-up and clears it from the
   * queue. Returns `null` — leaving the submission in place — when it fails
   * validation.
   *
   * **Re-validated here, not trusted from submission time.** The record has sat
   * in storage in between and, once submissions arrive over a link, will have
   * come from outside. A second check costs nothing; skipping it would make the
   * queue a way around the write gate.
   */
  async approvePendingFillUp(id: string): Promise<FillUpRecord | null> {
    // The fill-up and the cleared queue entry land together or not at all
    // (#85): one without the other let the same submission be approved twice.
    return atomically(this.repos, (r) => this.promote(r, id));
  }

  private async promote(r: Repositories, id: string): Promise<FillUpRecord | null> {
    const pending = await r.pendingFillUps.get(id);
    if (pending === undefined) return null;
    // The car may have been deleted while the submission waited; a fill-up
    // for a car that is gone would be invisible and uncountable (#3).
    if ((await r.vehicles.get(pending.vehicleId)) === undefined) return null;

    const draft = makeFuelEntryDraft({
      date: new Date(pending.date),
      odometer: pending.odometer,
      gallons: pending.gallons,
      pricePerGallon: pending.pricePerGallon,
      isFullTank: pending.isFullTank,
      fuelGrade: pending.fuelGrade,
      station: pending.station,
      notes: pending.notes,
      latitude: pending.latitude,
      longitude: pending.longitude,
      receiptImageData: pending.receiptImageData,
    });
    if (draft === null) return null;

    const record = await this.writeFillUp(r, draft, pending.vehicleId);
    await this.clearSubmission(r, id);
    return record;
  }

  async rejectPendingFillUp(id: string): Promise<void> {
    await this.clearSubmission(this.repos, id);
  }

  /**
   * Tombstones a submission once it has been dealt with.
   *
   * A submission is the one record here written by somebody else, so its
   * tombstone keeps neither their name nor their note — approved or rejected,
   * the queue entry has done its job and the content belongs to the fill-up it
   * became, if it became one.
   */
  private async clearSubmission(repos: Repositories, id: string): Promise<void> {
    const at = this.clock.now();
    await repos.pendingFillUps.remove(id, (row) => tombstonePending(row, at));
  }

  // MARK: Cleaning up older tombstones

  /**
   * Empties tombstones that an older build left full, and reports how many.
   *
   * Fixing the writer does nothing for the rows already on disk and already in
   * the account, and those are the ones holding the receipt photographs of
   * fill-ups somebody deleted (#25). Rewriting a row bumps its `updatedAt`, so
   * the next sync pushes the thin version over the fat document — which is the
   * only way the remote copy is ever erased.
   *
   * Safe to call on every load: a scrubbed row is recognised as scrubbed and
   * left alone, so this does nothing after the first time rather than
   * rewriting and re-pushing the same rows forever.
   */
  async scrubTombstones(): Promise<number> {
    // Read and rewritten in one transaction (#85).
    return atomically(
      this.repos,
      async (r) =>
        (await this.scrub(r.vehicles, tombstoneVehicle)) +
        (await this.scrub(r.fillUps, tombstoneFillUp)) +
        (await this.scrub(r.pendingFillUps, tombstonePending)),
    );
  }

  private async scrub<T extends SyncFields>(
    repo: Repository<T>,
    tombstone: Tombstoner<T>,
  ): Promise<number> {
    let fixed = 0;
    for (const row of await repo.listDeleted()) {
      if (isScrubbed(row, tombstone)) continue;
      // `updatedAt` moves so the rewrite propagates; `deletedAt` does not,
      // because when something was deleted is a fact and not ours to restate.
      await repo.put({ ...tombstone(row, this.clock.now()), deletedAt: row.deletedAt });
      fixed += 1;
    }
    return fixed;
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
    const ids = await this.repairOversizedTextIn(await this.exportSnapshot());
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

  // MARK: Backup

  /**
   * Everything in storage, tombstones included, for an export.
   *
   * Delegated rather than exposing the repositories as a property: handing them
   * out would give a caller a way to `put` a fill-up straight into storage,
   * which is precisely the door `addFillUp` exists to be the only one of.
   */
  async exportSnapshot(): Promise<Snapshot> {
    return exportSnapshot(this.repos);
  }

  /** Merges a parsed backup in. See `data/backup.ts` for the rules. */
  async importBackup(snapshot: Snapshot, tieBreak?: TieBreak): Promise<ImportSummary> {
    return importBackup(this.repos, snapshot, tieBreak);
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

  private recordFromDraft(
    draft: FuelEntryDraft,
    vehicleId: string,
    id: string,
  ): FillUpRecord {
    return {
      id,
      updatedAt: this.clock.now(),
      deletedAt: null,
      schemaVersion: SCHEMA_VERSION,
      vehicleId,
      date: draft.date.getTime(),
      odometer: draft.odometer,
      gallons: draft.gallons,
      pricePerGallon: draft.pricePerGallon,
      isFullTank: draft.isFullTank,
      missedPreviousFillUp: draft.missedPreviousFillUp,
      fuelGrade: draft.fuelGrade,
      station: draft.station,
      notes: draft.notes,
      latitude: draft.latitude,
      longitude: draft.longitude,
      receiptImageData: draft.receiptImageData,
    };
  }
}

// `toStats` lives beside the records it maps (#56), so a screen can use it
// without importing the store; re-exported here for existing callers.
export { toStats } from './records';
