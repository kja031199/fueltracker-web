/**
 * Unit conversions, ported from `Shared/Support/MeasurementUnits.swift`.
 *
 * The app stores every measurement in one canonical unit — **miles**, **US
 * gallons**, and **US MPG** — and converts only at the display and entry
 * boundary. Nothing in the model or in the statistics layer changes with the
 * user's unit choice; these functions own the conversions that sit between
 * stored values and what the user sees or types.
 *
 * Units are plain string literals rather than classes so they serialise into
 * IndexedDB and JSON exports unchanged.
 */

export type VolumeUnit = 'gallons' | 'liters';
export type DistanceUnit = 'miles' | 'kilometers';
export type EconomyUnit = 'mpg' | 'litersPer100km' | 'kmPerLiter';

/** Exact liters in one US gallon. */
export const LITERS_PER_GALLON = 3.785411784;
/** Exact kilometers in one mile. */
export const KILOMETERS_PER_MILE = 1.609344;

export const VOLUME_UNITS = ['gallons', 'liters'] as const;
export const DISTANCE_UNITS = ['miles', 'kilometers'] as const;
export const ECONOMY_UNITS = ['mpg', 'litersPer100km', 'kmPerLiter'] as const;

interface VolumeSpec {
  readonly abbreviation: string;
  readonly name: string;
  /** Singular noun for labels like "Price per Gallon" / "Price per Liter". */
  readonly singularNoun: string;
  /** A canonical gallons value expressed in this unit. */
  readonly fromGallons: (gallons: number) => number;
  /** A value in this unit converted back to canonical gallons. */
  readonly toGallons: (value: number) => number;
}

export const volume: Record<VolumeUnit, VolumeSpec> = {
  gallons: {
    abbreviation: 'gal',
    name: 'Gallons',
    singularNoun: 'Gallon',
    fromGallons: (g) => g,
    toGallons: (v) => v,
  },
  liters: {
    abbreviation: 'L',
    name: 'Liters',
    singularNoun: 'Liter',
    fromGallons: (g) => g * LITERS_PER_GALLON,
    toGallons: (v) => v / LITERS_PER_GALLON,
  },
};

interface DistanceSpec {
  readonly abbreviation: string;
  readonly name: string;
  /** Singular noun for titles like "Cost per Mile" / "Cost per Kilometer". */
  readonly singularNoun: string;
  readonly fromMiles: (miles: number) => number;
  readonly toMiles: (value: number) => number;
}

export const distance: Record<DistanceUnit, DistanceSpec> = {
  miles: {
    abbreviation: 'mi',
    name: 'Miles',
    singularNoun: 'Mile',
    fromMiles: (m) => m,
    toMiles: (v) => v,
  },
  kilometers: {
    abbreviation: 'km',
    name: 'Kilometers',
    singularNoun: 'Kilometer',
    fromMiles: (m) => m * KILOMETERS_PER_MILE,
    toMiles: (v) => v / KILOMETERS_PER_MILE,
  },
};

interface EconomySpec {
  readonly abbreviation: string;
  readonly name: string;
  /**
   * True when a larger number is better economy. False for L/100km, where less
   * fuel per distance — a smaller number — is better. Ranking itself is always
   * done on canonical MPG; this only affects how a displayed number reads.
   */
  readonly higherIsBetter: boolean;
  /**
   * A canonical MPG value expressed in this unit, or `null` when the value is
   * non-positive or non-finite — economy is undefined there (and L/100km would
   * divide by zero), so callers show a placeholder instead.
   *
   * Note this is **not** linear: L/100km is the reciprocal of distance-per-
   * volume, so a higher MPG produces a *lower* number.
   */
  readonly fromMPG: (mpg: number) => number | null;
}

/** Shared guard: economy is undefined for non-finite or non-positive input. */
const definedMPG = (mpg: number): boolean => Number.isFinite(mpg) && mpg > 0;

export const economy: Record<EconomyUnit, EconomySpec> = {
  mpg: {
    abbreviation: 'MPG',
    name: 'Miles per gallon',
    higherIsBetter: true,
    fromMPG: (mpg) => (definedMPG(mpg) ? mpg : null),
  },
  litersPer100km: {
    abbreviation: 'L/100km',
    name: 'Liters per 100 km',
    higherIsBetter: false,
    fromMPG: (mpg) =>
      definedMPG(mpg) ? (100 * LITERS_PER_GALLON) / (mpg * KILOMETERS_PER_MILE) : null,
  },
  kmPerLiter: {
    abbreviation: 'km/L',
    name: 'Kilometers per liter',
    higherIsBetter: true,
    fromMPG: (mpg) => (definedMPG(mpg) ? mpg * (KILOMETERS_PER_MILE / LITERS_PER_GALLON) : null),
  },
};

/** The user's three unit choices, bundled so they pass through as one value. */
export interface UnitPreferences {
  readonly volume: VolumeUnit;
  readonly distance: DistanceUnit;
  readonly economy: EconomyUnit;
}

/**
 * US customary units — the app's canonical storage units, and the default for
 * non-metric locales.
 */
export const US: UnitPreferences = { volume: 'gallons', distance: 'miles', economy: 'mpg' };

/** Metric units, the default seed for metric locales. */
export const METRIC: UnitPreferences = {
  volume: 'liters',
  distance: 'kilometers',
  economy: 'litersPer100km',
};

/**
 * The regions that do not use the metric system. Swift reads
 * `Locale.measurementSystem`; the equivalent `Intl.Locale.measurementSystem` is
 * still poorly supported, so the region list is spelled out. It only has to be
 * a reasonable default — the user can change all three in Settings.
 */
const NON_METRIC_REGIONS = new Set(['US', 'LR', 'MM', 'AS', 'GU', 'MP', 'PR', 'VI']);

/**
 * A sensible starting point for a locale: metric locales seed metric,
 * everything else seeds US.
 */
export function unitPreferencesForLocale(locale: string): UnitPreferences {
  const region = regionForLocale(locale);
  return region !== undefined && NON_METRIC_REGIONS.has(region) ? US : METRIC;
}

/**
 * The region subtag of a locale, or `undefined` if there isn't one.
 *
 * Exported because currency resolution needs the same answer, and the fallback
 * below is the part worth sharing rather than reimplementing: `Intl.Locale`
 * rejects some tags outright, so a malformed or underscore-separated tag —
 * `"en_US"`, which is how Swift writes it — has to be parsed directly instead
 * of being silently treated as region-less.
 */
export function regionForLocale(locale: string): string | undefined {
  try {
    const region = new Intl.Locale(locale).region;
    if (region !== undefined && region !== null) return region;
  } catch {
    // Fall through to direct parsing.
  }
  const parts = locale.split(/[-_]/);
  return parts.find((p) => /^[A-Za-z]{2}$/.test(p) && p === p.toUpperCase());
}
