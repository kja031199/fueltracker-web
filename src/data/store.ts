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
import type { FuelEntryStats } from '../domain/models';
import type { FillUpRecord, PendingFillUpRecord, VehicleRecord } from './records';
import { SCHEMA_VERSION } from './records';
import type { Repository } from './repository';
import type { BackupSnapshot } from '../domain/backupFormat';
import type { ImportSummary } from './backup';
import { exportSnapshot, importBackup } from './backup';

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
  readonly fillUps: Repository<FillUpRecord>;
  readonly pendingFillUps: Repository<PendingFillUpRecord>;
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
  ) {}

  // MARK: Vehicles

  async addVehicle(vehicle: NewVehicle): Promise<VehicleRecord> {
    const now = this.clock.now();
    const record: VehicleRecord = {
      id: this.clock.newId(),
      updatedAt: now,
      deletedAt: null,
      schemaVersion: SCHEMA_VERSION,
      name: vehicle.name,
      make: vehicle.make ?? '',
      model: vehicle.model ?? '',
      year: vehicle.year ?? new Date(now).getFullYear(),
      createdAt: now,
    };
    await this.repos.vehicles.put(record);
    return record;
  }

  async vehicles(): Promise<VehicleRecord[]> {
    const rows = await this.repos.vehicles.list();
    return rows.sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * Tombstones the vehicle **and its fill-ups**, mirroring the cascade delete
   * upstream. Done explicitly because a tombstone cannot cascade on its own:
   * orphaned rows would otherwise stay live, invisible in the UI but present in
   * storage and ready to sync back as a vehicle with no owner.
   */
  async removeVehicle(vehicleId: string): Promise<void> {
    const entries = await this.repos.fillUps.list();
    for (const entry of entries) {
      if (entry.vehicleId === vehicleId) await this.repos.fillUps.remove(entry.id);
    }
    await this.repos.vehicles.remove(vehicleId);
  }

  // MARK: Fill-ups — the only write path

  /**
   * Writes a validated draft as a fill-up on `vehicleId`.
   *
   * Takes a draft rather than raw fields on purpose: the type system, not a
   * code review, is what stops an unvalidated entry reaching storage.
   */
  async addFillUp(draft: FuelEntryDraft, vehicleId: string): Promise<FillUpRecord> {
    const record = this.recordFromDraft(draft, vehicleId, this.clock.newId());
    await this.repos.fillUps.put(record);
    return record;
  }

  /**
   * Replaces an existing fill-up from a draft, keeping its id.
   *
   * Editing runs through the same validation as creating — an edit that would
   * zero the gallons has to fail exactly as a creation would, which it does by
   * never producing a draft in the first place.
   */
  async updateFillUp(id: string, draft: FuelEntryDraft, vehicleId: string): Promise<FillUpRecord> {
    const record = this.recordFromDraft(draft, vehicleId, id);
    await this.repos.fillUps.put(record);
    return record;
  }

  async removeFillUp(id: string): Promise<void> {
    await this.repos.fillUps.remove(id);
  }

  /** One vehicle's live fill-ups, newest first. */
  async fillUps(vehicleId: string): Promise<FillUpRecord[]> {
    const rows = await this.repos.fillUps.list();
    return rows.filter((row) => row.vehicleId === vehicleId).sort((a, b) => b.date - a.date);
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
      submitterName,
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
    const pending = await this.repos.pendingFillUps.get(id);
    if (pending === undefined) return null;

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

    const record = await this.addFillUp(draft, pending.vehicleId);
    await this.repos.pendingFillUps.remove(id);
    return record;
  }

  async rejectPendingFillUp(id: string): Promise<void> {
    await this.repos.pendingFillUps.remove(id);
  }

  // MARK: Backup

  /**
   * Everything in storage, tombstones included, for an export.
   *
   * Delegated rather than exposing the repositories as a property: handing them
   * out would give a caller a way to `put` a fill-up straight into storage,
   * which is precisely the door `addFillUp` exists to be the only one of.
   */
  async exportSnapshot(): Promise<BackupSnapshot> {
    return exportSnapshot(this.repos);
  }

  /** Merges a parsed backup in. See `data/backup.ts` for the rules. */
  async importBackup(snapshot: BackupSnapshot): Promise<ImportSummary> {
    return importBackup(this.repos, snapshot);
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

/**
 * Stored rows in the shape the statistics layer reads.
 *
 * The bridge between the two halves of the app, and the only place that knows
 * both. Statistics never sees a record and storage never sees a `Date`-shaped
 * entry.
 */
export function toStats(records: readonly FillUpRecord[]): FuelEntryStats[] {
  return records.map((record) => ({
    id: record.id,
    date: new Date(record.date),
    odometer: record.odometer,
    gallons: record.gallons,
    pricePerGallon: record.pricePerGallon,
    isFullTank: record.isFullTank,
    missedPreviousFillUp: record.missedPreviousFillUp,
  }));
}
