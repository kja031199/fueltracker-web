/**
 * The words the app shows for its identifiers (#94).
 *
 * `domain/` names things by identifier (`'liters'`, `'economy'`, a stored
 * grade, a weekday number) and by unit symbol (`L`, `km`); it says nothing in
 * English, and `src/test/domainWords.test.ts` keeps it that way. Every label a
 * reader sees for one of those identifiers comes from here, so a translation
 * would replace this file and the phrasers beside it, never the domain.
 */

import type { DashboardTimeRange } from '../domain/dashboardTimeRange';
import type { FuelGrade } from '../domain/fuelGrade';
import type { DistanceUnit, EconomyUnit, VolumeUnit } from '../domain/units';

interface UnitWords {
  /** The unit's plural name, as a field label: "Gallons". */
  readonly name: string;
  /** The singular, for "Price per Gallon" or "Cost per Kilometer". */
  readonly noun: string;
}

export const volumeWords: Record<VolumeUnit, UnitWords> = {
  gallons: { name: 'Gallons', noun: 'Gallon' },
  liters: { name: 'Liters', noun: 'Liter' },
};

export const distanceWords: Record<DistanceUnit, UnitWords> = {
  miles: { name: 'Miles', noun: 'Mile' },
  kilometers: { name: 'Kilometers', noun: 'Kilometer' },
};

/** The economy unit's name, for the Settings picker. */
export const economyNames: Record<EconomyUnit, string> = {
  mpg: 'Miles per gallon',
  litersPer100km: 'Liters per 100 km',
  kmPerLiter: 'Kilometers per liter',
};

const GRADE_LABELS: Record<FuelGrade, string> = {
  Regular: 'Regular',
  Midgrade: 'Midgrade',
  Premium: 'Premium',
  Diesel: 'Diesel',
  E85: 'E85',
  Other: 'Other',
};

/**
 * A fuel grade as shown. The stored identifier happens to be English — it is
 * Swift's `fuelGradeRaw`, and cannot change — but what a reader sees comes
 * from here, so it could.
 */
export function gradeLabel(grade: FuelGrade): string {
  return GRADE_LABELS[grade];
}

const RANGE_LABELS: Record<DashboardTimeRange, string> = {
  '3M': '3M',
  '6M': '6M',
  '1Y': '1Y',
  All: 'All time',
};

/** A time range as its picker shows it. */
export function rangeLabel(range: DashboardTimeRange): string {
  return RANGE_LABELS[range];
}

/** Used only if `Intl` cannot name the days, which it always can in practice. */
const FALLBACK_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const FALLBACK_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * A week of real dates, Sunday first, used only as input to `Intl` so the day
 * names come from the platform rather than a hand-written table. 2025-01-05 is
 * a Sunday; the six days after it complete the week.
 */
const REFERENCE_WEEK = Array.from({ length: 7 }, (_, i) => new Date(2025, 0, 5 + i));

/** Day names, Sunday first, so weekday `n` (1 = Sunday) is `names[n - 1]`. */
export function weekdayNames(locale: string, width: 'short' | 'long'): string[] {
  try {
    const formatter = new Intl.DateTimeFormat(locale, { weekday: width });
    const names = REFERENCE_WEEK.map((date) => formatter.format(date));
    if (names.every((name) => name.length > 0)) return names;
  } catch {
    // Fall through to the English fallback.
  }
  return width === 'short' ? [...FALLBACK_SHORT] : [...FALLBACK_LONG];
}

/** One weekday's name: 1 = Sunday … 7 = Saturday. Empty outside that range. */
export function weekdayName(weekday: number, locale: string, width: 'short' | 'long'): string {
  return weekdayNames(locale, width)[weekday - 1] ?? '';
}
