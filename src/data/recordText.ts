/**
 * Text bounds applied to whole records (#50).
 *
 * `boundText` shortens one string; this knows which fields of which record are
 * text, so the store, the import path and sync can bound a row without each
 * keeping its own list. A row that already fits is returned **as the same
 * object**, which is how a caller tells "repaired" from "fine" without
 * comparing every field.
 */

import { TEXT_LIMITS, boundText, type TextField } from '../domain/textLimits';
import type { FillUpRecord, PendingFillUpRecord, VehicleRecord } from './records';

const VEHICLE_TEXT = ['name', 'make', 'model'] as const satisfies readonly TextField[];
const FILL_UP_TEXT = ['station', 'notes', 'fuelGrade'] as const satisfies readonly TextField[];
const PENDING_TEXT = ['submitterName', 'station', 'notes', 'fuelGrade'] as const satisfies readonly TextField[];

function bound<T extends object>(row: T, fields: readonly TextField[]): T {
  let changed: Record<string, string> | null = null;
  for (const field of fields) {
    const value = (row as Record<string, unknown>)[field];
    if (typeof value !== 'string') continue;
    const bounded = boundText(value, TEXT_LIMITS[field]);
    if (bounded !== value) (changed ??= {})[field] = bounded;
  }
  return changed === null ? row : { ...row, ...changed };
}

export function boundVehicleText(row: VehicleRecord): VehicleRecord {
  return bound(row, VEHICLE_TEXT);
}

export function boundFillUpText(row: FillUpRecord): FillUpRecord {
  return bound(row, FILL_UP_TEXT);
}

export function boundPendingText(row: PendingFillUpRecord): PendingFillUpRecord {
  return bound(row, PENDING_TEXT);
}

/**
 * The first text field over its limit, or `null` when every one fits.
 *
 * For the last check before a push: by then every door has bounded its text
 * and the stored rows have been repaired, so this should never find anything.
 * It is there so that if something new ever does slip through, it costs one
 * row rather than the whole upload.
 */
export function textProblem(row: object): string | null {
  for (const field of Object.keys(TEXT_LIMITS) as TextField[]) {
    const value = (row as Record<string, unknown>)[field];
    if (typeof value === 'string' && value.length > TEXT_LIMITS[field]) {
      return `its ${field} is longer than ${TEXT_LIMITS[field]} characters`;
    }
  }
  return null;
}
