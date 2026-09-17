/**
 * The rules behind the fill-up form, ported from
 * `Shared/Support/FillUpFormModel.swift`.
 *
 * Upstream this is an observable class that owns both the field state and the
 * rules. Here the state lives in React, because that is what React is for, and
 * only the **rules** port — as pure functions that take values and return
 * answers. That split is what makes them testable without rendering a form, and
 * it is the same reasoning that kept statistics out of the views.
 *
 * Saving is not here either. The form produces a `FuelEntryDraft`; the store
 * writes it. There is still exactly one write path.
 */

import type { FuelEntryDraft } from './fuelEntryDraft';
import { makeFuelEntryDraft } from './fuelEntryDraft';
import type { FuelGrade } from './fuelGrade';

/** The form's fields, in **canonical** units — miles, US gallons, per gallon. */
export interface FillUpFormState {
  readonly date: Date;
  readonly odometer: number | null;
  readonly gallons: number | null;
  readonly pricePerGallon: number | null;
  readonly isFullTank: boolean;
  readonly missedPreviousFillUp: boolean;
  readonly fuelGrade: FuelGrade;
  readonly station: string;
  readonly notes: string;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly receiptImageData: Uint8Array | null;
}

export function emptyFillUpForm(now: Date = new Date()): FillUpFormState {
  return {
    date: now,
    odometer: null,
    gallons: null,
    pricePerGallon: null,
    isFullTank: true,
    missedPreviousFillUp: false,
    fuelGrade: 'Regular',
    station: '',
    notes: '',
    latitude: null,
    longitude: null,
    receiptImageData: null,
  };
}

/**
 * Live total, shown as the reader types.
 *
 * A missing field counts as zero rather than blanking the line, so the total
 * appears as soon as both numbers exist and never flickers between a value and
 * nothing while one is being edited.
 */
export function formTotalCost(state: Pick<FillUpFormState, 'gallons' | 'pricePerGallon'>): number {
  return (state.gallons ?? 0) * (state.pricePerGallon ?? 0);
}

/**
 * The draft this form would save, or `null` if it cannot be saved yet.
 *
 * The single point where loose form state becomes something writable. All the
 * validation lives in `makeFuelEntryDraft` rather than being restated here.
 */
export function draftFromForm(state: FillUpFormState): FuelEntryDraft | null {
  return makeFuelEntryDraft({
    date: state.date,
    odometer: state.odometer,
    gallons: state.gallons,
    pricePerGallon: state.pricePerGallon,
    isFullTank: state.isFullTank,
    missedPreviousFillUp: state.missedPreviousFillUp,
    fuelGrade: state.fuelGrade,
    station: state.station,
    notes: state.notes,
    latitude: state.latitude,
    longitude: state.longitude,
    receiptImageData: state.receiptImageData,
  });
}

export function canSaveForm(state: FillUpFormState): boolean {
  return draftFromForm(state) !== null;
}

/**
 * The highest odometer already logged, for sanity-checking a new entry.
 *
 * `null` while **editing**, and that exception matters: correcting an old
 * fill-up legitimately has a reading below the latest one, and warning about it
 * would train the reader to ignore the warning.
 */
export function previousOdometer(
  existingOdometers: readonly number[],
  isEditing: boolean,
): number | null {
  if (isEditing || existingOdometers.length === 0) return null;
  return Math.max(...existingOdometers);
}

/**
 * Whether the entered odometer is at or below the last one recorded.
 *
 * A **warning, not a block**. An odometer that went backwards is usually a
 * typo, but it can also be a replaced cluster or a genuine correction, and the
 * app does not know which — so it says so and lets the person decide.
 */
export function odometerLooksWrong(odometer: number | null, previous: number | null): boolean {
  if (odometer === null || previous === null) return false;
  return odometer <= previous;
}
