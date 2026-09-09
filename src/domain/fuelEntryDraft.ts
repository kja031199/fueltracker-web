import type { FuelGrade } from './fuelGrade';

/**
 * A validated fill-up ready to be written to the store. Ported from
 * `Shared/Models/FuelEntryDraft.swift`.
 *
 * Every new or edited entry passes through here: construction **fails**
 * (returns `null`) unless the required numeric fields are present, positive and
 * finite, so no code path can insert an unvalidated entry. Any future source of
 * fill-ups — a shared-link submission from another person, an import, a
 * restored backup — builds one of these too, which keeps validation in exactly
 * one place instead of trusting each caller.
 *
 * This is invariant 4 of the original architecture and it carries over intact.
 * Do not add a second write path.
 */
export interface FuelEntryDraft {
  readonly date: Date;
  readonly odometer: number;
  readonly gallons: number;
  readonly pricePerGallon: number;
  readonly isFullTank: boolean;
  readonly missedPreviousFillUp: boolean;
  readonly fuelGrade: FuelGrade;
  readonly station: string;
  readonly notes: string;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly receiptImageData: Uint8Array | null;
}

/**
 * A sanitised receipt is a couple of hundred KB. Anything past this ceiling at
 * the write boundary means the bounded image-intake path was bypassed, so the
 * blob is dropped rather than persisted unbounded.
 */
export const MAX_RECEIPT_BYTES = 4 * 1024 * 1024;

export interface FuelEntryDraftInput {
  date: Date;
  odometer: number | null | undefined;
  gallons: number | null | undefined;
  pricePerGallon: number | null | undefined;
  isFullTank?: boolean;
  missedPreviousFillUp?: boolean;
  fuelGrade?: FuelGrade;
  station?: string;
  notes?: string;
  latitude?: number | null;
  longitude?: number | null;
  receiptImageData?: Uint8Array | null;
}

/**
 * Positive **and finite**. `NaN` fails the `> 0` test already; the explicit
 * finite check also rejects `+∞`, which would otherwise slip through as
 * "positive" from a crafted or corrupted record and poison every statistic.
 */
function isValidMeasurement(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Build a validated draft, or `null` when any required measurement is missing,
 * non-positive or non-finite.
 *
 * An oversized receipt is **dropped while the draft still succeeds** — losing
 * the photo is recoverable, losing the fill-up is not.
 */
export function makeFuelEntryDraft(input: FuelEntryDraftInput): FuelEntryDraft | null {
  const { odometer, gallons, pricePerGallon } = input;
  if (!isValidMeasurement(odometer)) return null;
  if (!isValidMeasurement(gallons)) return null;
  if (!isValidMeasurement(pricePerGallon)) return null;

  const receipt = input.receiptImageData ?? null;
  const keptReceipt = receipt !== null && receipt.byteLength <= MAX_RECEIPT_BYTES ? receipt : null;

  return {
    date: input.date,
    odometer,
    gallons,
    pricePerGallon,
    isFullTank: input.isFullTank ?? true,
    missedPreviousFillUp: input.missedPreviousFillUp ?? false,
    fuelGrade: input.fuelGrade ?? 'Regular',
    station: input.station ?? '',
    notes: input.notes ?? '',
    latitude: input.latitude ?? null,
    longitude: input.longitude ?? null,
    receiptImageData: keptReceipt,
  };
}

/** Total cost is always derived, never stored. */
export function draftTotalCost(draft: FuelEntryDraft): number {
  return draft.gallons * draft.pricePerGallon;
}
