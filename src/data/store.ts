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
import type { FillUpRecord, PendingFillUpRecord, SyncFields, VehicleRecord, Snapshot } from './records';
import { SCHEMA_VERSION } from './records';
import type { Repositories, Repository } from './repository';
import { MonotonicClock } from './syncClock';
import type { FillUpSummary } from './records';
import { toSummary } from './records';
import type { Tombstoner } from './tombstone';
import { isScrubbed, tombstoneFillUp, tombstonePending, tombstoneVehicle } from './tombstone';
import type { ImportSummary } from './backup';
import type { Submission } from './fillUpLink';
import { exportSnapshot, importBackup } from './backup';
import { Replica } from './replica';
import { draftFromRecord, fillUpFromDraft, pendingFromDraft } from './recordMapping';
import { atomically } from './atomically';
import { TEXT_LIMITS, boundText } from '../domain/textLimits';
import { StaleEdit } from './staleEdit';



export interface NewVehicle {
  readonly name: string;
  readonly make?: string;
  readonly model?: string;
  readonly year?: number;
}

export class FuelTrackerStore {
  constructor(
    private readonly repos: Repositories,
    /**
     * Stamps every write, and is **the** clock sync observes the account's
     * stamps on (#91): sync takes it from here, so the two can never be
     * different clocks. It used to be passed to each separately, defaulting
     * to two different ones, and only the app's wiring made them the same.
     * Its own by default; the app gives every store `sharedSyncClock`.
     */
    readonly clock: MonotonicClock = new MonotonicClock(),
    /**
     * The signed-in account, stamped on each new fill-up as `enteredBy`
     * (#66). `null` where there is no account: tests, the demo, local-only.
     */
    private readonly author: string | null = null,
  ) {
    this.replica = new Replica(repos, clock);
  }

  /**
   * This store's rows as sync sees them (#91): what sync is handed, and the
   * only way to its operations. Same repositories, same clock.
   */
  readonly replica: Replica;

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
    return this.replica.hasVehicle(id);
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
    const record = fillUpFromDraft(draft, {
      id: this.clock.newId(),
      vehicleId,
      updatedAt: this.clock.now(),
      enteredBy: this.author,
    });
    await repos.fillUps.put(record);
    return record;
  }

  /**
   * Replaces a fill-up's contents, **on the car it is already on** (#83),
   * keeping its id. Editing runs through the same validation as creating: an
   * edit that would zero the gallons never produces a draft in the first place.
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
      const record = fillUpFromDraft(draft, {
        id,
        vehicleId: existing.vehicleId,
        updatedAt: this.clock.now(),
        enteredBy: existing.enteredBy ?? null,
      });
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
    await r.pendingFillUps.put(
      pendingFromDraft(
        // Text only: a link never carries a photo or a place, whatever the
        // draft it decoded to says.
        { ...submission.draft, latitude: null, longitude: null, receiptImageData: null },
        {
          id: submission.id,
          vehicleId: submission.vehicleId,
          updatedAt: this.clock.now(),
          submittedAt: submission.submittedAt,
          submitterName: submission.submitterName,
        },
      ),
    );
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

    const draft = draftFromRecord(pending);
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

  /**
   * Merges a backup file in. See `data/backup.ts` for the rules. A file has
   * no tie-break: an equal stamp keeps what is here, so importing the same
   * file twice changes nothing. Sync's merge, which has one, is the replica's.
   */
  async importBackup(snapshot: Snapshot): Promise<ImportSummary> {
    return importBackup(this.repos, snapshot);
  }

}
