/**
 * A draft and a stored record, in each direction — written once (#91).
 *
 * The field-by-field copy between `FuelEntryDraft` and the two records that
 * hold its measurements used to be written out in four places in the store and
 * once more in the import, and the copies had begun to differ. Every write
 * path now builds its record here, and every read that needs a draft back
 * gets it here — through `makeFuelEntryDraft`, so a record never becomes a
 * draft the gate would have refused.
 */

import type { FuelEntryDraft } from '../domain/fuelEntryDraft';
import { makeFuelEntryDraft } from '../domain/fuelEntryDraft';
import { TEXT_LIMITS, boundText } from '../domain/textLimits';
import type { FillUpRecord, PendingFillUpRecord } from './records';
import { SCHEMA_VERSION } from './records';

/** The measurements and details a draft carries, as both records store them. */
function measurementsOf(draft: FuelEntryDraft) {
  return {
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
}

/** A live fill-up from a draft. The draft is already through the gate. */
export function fillUpFromDraft(
  draft: FuelEntryDraft,
  meta: {
    readonly id: string;
    readonly vehicleId: string;
    readonly updatedAt: number;
    /** Who logged it (#66), or `null` where nobody is known. */
    readonly enteredBy: string | null;
  },
): FillUpRecord {
  return {
    id: meta.id,
    updatedAt: meta.updatedAt,
    deletedAt: null,
    schemaVersion: SCHEMA_VERSION,
    vehicleId: meta.vehicleId,
    ...measurementsOf(draft),
    missedPreviousFillUp: draft.missedPreviousFillUp,
    enteredBy: meta.enteredBy,
  };
}

/**
 * A waiting submission from a draft. A submission has no "missed the previous
 * fill-up": that is a fact about the owner's log, which the sender never sees.
 */
export function pendingFromDraft(
  draft: FuelEntryDraft,
  meta: {
    readonly id: string;
    readonly vehicleId: string;
    readonly updatedAt: number;
    readonly submittedAt: number;
    readonly submitterName: string;
  },
): PendingFillUpRecord {
  return {
    id: meta.id,
    updatedAt: meta.updatedAt,
    deletedAt: null,
    schemaVersion: SCHEMA_VERSION,
    vehicleId: meta.vehicleId,
    submittedAt: meta.submittedAt,
    // The one text a draft does not carry, so bounded here (#50).
    submitterName: boundText(meta.submitterName, TEXT_LIMITS.submitterName),
    ...measurementsOf(draft),
  };
}

/**
 * The draft a stored fill-up or submission describes — through the gate
 * again, so `null` for one whose numbers it would refuse. A record has sat in
 * storage, and may have come from another device or a file; it is not trusted
 * for having been valid once.
 */
export function draftFromRecord(record: FillUpRecord | PendingFillUpRecord): FuelEntryDraft | null {
  return makeFuelEntryDraft({
    date: new Date(record.date),
    odometer: record.odometer,
    gallons: record.gallons,
    pricePerGallon: record.pricePerGallon,
    isFullTank: record.isFullTank,
    missedPreviousFillUp: 'missedPreviousFillUp' in record ? record.missedPreviousFillUp : false,
    fuelGrade: record.fuelGrade,
    station: record.station,
    notes: record.notes,
    latitude: record.latitude,
    longitude: record.longitude,
    receiptImageData: record.receiptImageData,
  });
}
