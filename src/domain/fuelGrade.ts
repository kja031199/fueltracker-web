/** Ported from `Shared/Models/FuelGrade.swift`. */

export const FUEL_GRADES = ['Regular', 'Midgrade', 'Premium', 'Diesel', 'E85', 'Other'] as const;

export type FuelGrade = (typeof FUEL_GRADES)[number];

/**
 * Resolve a stored raw string to a grade, falling back to `Other`.
 *
 * The Swift model stores `fuelGradeRaw: String` and its computed property
 * degrades to `.other` for an unrecognised value rather than trapping, so a
 * record written by a newer version (or corrupted in transit) can still be
 * read. Same contract here — never throw on stored data.
 */
export function fuelGradeFromRaw(raw: string): FuelGrade {
  return (FUEL_GRADES as readonly string[]).includes(raw) ? (raw as FuelGrade) : 'Other';
}
