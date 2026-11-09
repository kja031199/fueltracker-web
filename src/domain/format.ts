/**
 * Number formatting for display, ported from `Shared/Support/Formatters.swift`.
 *
 * **Only the helpers with callers.** Upstream's `Format` enum has a dozen; this
 * file carries the six the ported domain modules actually use — `plainCurrency`
 * for the weekday insight, and `currency` / `economy` / `fuelPrice` /
 * `costPerDistance` / `distance` for the vehicle showdown's rows. The rest
 * (`volume`, `compactMiles`, `odometer`, …) describe screens that do not exist
 * here yet and port in Phase 3 with the views that call them. Untested
 * formatters with no callers are exactly the dead weight this phase avoids.
 *
 * ## The unit-aware half
 *
 * These take a value in the app's **canonical** unit — gallons, miles, MPG —
 * and render it in the unit the reader chose. Storage never changes with that
 * choice and neither does any ranking; conversion happens here, at the display
 * boundary, and nowhere else.
 */

import type { DistanceUnit, EconomyUnit, VolumeUnit } from './units';
import {
  distance as distanceUnits,
  economy as economyUnits,
  pricePerUnit,
  regionForLocale,
  volume as volumeUnits,
} from './units';

/**
 * Currency for a locale's region, defaulting to USD.
 *
 * Swift reads `Locale.current.currency`, which has **no `Intl` equivalent** —
 * there is no standard locale→currency lookup in JavaScript — so the common
 * cases are spelled out. Like the non-metric region list in `units.ts`, this
 * only has to be a reasonable default; an explicit currency preference belongs
 * with the other Settings choices in Phase 3.
 */
const REGION_CURRENCY: Record<string, string> = {
  US: 'USD', CA: 'CAD', GB: 'GBP', AU: 'AUD', NZ: 'NZD',
  JP: 'JPY', CN: 'CNY', IN: 'INR', MX: 'MXN', BR: 'BRL',
  ZA: 'ZAR', CH: 'CHF', SE: 'SEK', NO: 'NOK', DK: 'DKK', PL: 'PLN',
  DE: 'EUR', FR: 'EUR', ES: 'EUR', IT: 'EUR', NL: 'EUR', IE: 'EUR',
  PT: 'EUR', AT: 'EUR', BE: 'EUR', FI: 'EUR', GR: 'EUR',
};

export const DEFAULT_CURRENCY = 'USD';

/** The currency code to use for a locale. */
const formatters = new Map<string, Intl.NumberFormat>();
const MAX_FORMATTERS = 64;

/**
 * One `Intl.NumberFormat` per locale and options, made once (#88). Building
 * one is far dearer than using one, and every row of every list called this
 * several times per render. An invalid locale or currency still throws, as
 * the constructor would: nothing is cached for it.
 */
export function numberFormat(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let formatter = formatters.get(key);
  if (formatter === undefined) {
    formatter = new Intl.NumberFormat(locale, options);
    // A handful of shapes in practice; capped so no input can grow it for ever.
    if (formatters.size >= MAX_FORMATTERS) formatters.clear();
    formatters.set(key, formatter);
  }
  return formatter;
}

export function currencyForLocale(locale: string): string {
  const region = regionForLocale(locale);
  return (region !== undefined ? REGION_CURRENCY[region] : undefined) ?? DEFAULT_CURRENCY;
}

export interface CurrencyOptions {
  /** BCP 47 tag. Defaults to `'en-US'` so output is deterministic in tests. */
  readonly locale?: string;
  /** Overrides the currency the locale would imply. */
  readonly currency?: string;
}

/**
 * Currency with **exactly two** decimal places — the form used for price labels
 * and for the weekday spread.
 *
 * The fraction length is pinned rather than left to the locale's default,
 * matching the Swift's `.precision(.fractionLength(2))`. That matters for
 * currencies `Intl` would otherwise render with no decimals at all (JPY), where
 * a half-cent spread would round away to nothing.
 *
 * A non-finite value is passed through to `Intl` rather than intercepted. Every
 * caller in the domain layer guards before formatting — `weekdayPriceInsight`'s
 * `delta * 100 >= 1` test is already false for `NaN` — so a non-finite value
 * arriving here means a new caller skipped its guard, and a visible oddity is a
 * better outcome than a plausible-looking zero.
 */
export function plainCurrency(value: number, options: CurrencyOptions = {}): string {
  const locale = options.locale ?? 'en-US';
  const currency = options.currency ?? currencyForLocale(locale);
  return numberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

/**
 * Currency at the locale's own precision — two places for most currencies, none
 * for JPY. Upstream's `Format.currency`, used for totals where the extra
 * pinning `plainCurrency` does would be wrong.
 */
export function currency(value: number, options: CurrencyOptions = {}): string {
  const locale = options.locale ?? 'en-US';
  return numberFormat(locale, {
    style: 'currency',
    currency: options.currency ?? currencyForLocale(locale),
    // No explicit fraction digits: the locale decides.
  }).format(value);
}

/**
 * A canonical **MPG** value in the given economy unit, or `null` where economy
 * is undefined.
 *
 * `null` rather than a placeholder string: the caller decides what an absent
 * value looks like, and a showdown row needs to tell "no data" apart from a
 * formatted zero in order to call the row no-contest.
 */
export function economy(mpg: number, unit: EconomyUnit): string | null {
  const converted = economyUnits[unit].fromMPG(mpg);
  if (converted === null) return null;
  return numberFormat('en-US', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(converted);
}

/**
 * A canonical **price per gallon** shown per the given volume unit, with the
 * extra tenth-of-a-cent digit fuel prices use ("$3.499"/gal, or its per-litre
 * equivalent).
 *
 * That third digit is not decoration: pump prices genuinely carry it, and
 * rounding it away would make two different prices display identically — which
 * the showdown would then have to call a tie.
 */
export function fuelPrice(
  pricePerGallon: number,
  unit: VolumeUnit,
  options: CurrencyOptions = {},
): string {
  const locale = options.locale ?? 'en-US';
  const perUnit = pricePerUnit(pricePerGallon, unit);
  return numberFormat(locale, {
    style: 'currency',
    currency: options.currency ?? currencyForLocale(locale),
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  }).format(perUnit);
}

/** A canonical **cost per mile** shown per the given distance unit. */
export function costPerDistance(
  costPerMile: number,
  unit: DistanceUnit,
  options: CurrencyOptions = {},
): string {
  const locale = options.locale ?? 'en-US';
  const perUnit = costPerMile / distanceUnits[unit].fromMiles(1);
  return numberFormat(locale, {
    style: 'currency',
    currency: options.currency ?? currencyForLocale(locale),
    minimumFractionDigits: 2,
    maximumFractionDigits: 3,
  }).format(perUnit);
}

/**
 * A canonical **gallons** value in the given volume unit, optionally suffixed.
 *
 * Up to three fraction digits and no trailing zeros: a pump reads 9.5 gallons,
 * not 9.500, and 12.345 litres keeps every digit it printed.
 */
export function volume(gallons: number, unit: VolumeUnit, withUnit = false): string {
  const spec = volumeUnits[unit];
  const number = numberFormat('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  }).format(spec.fromGallons(gallons));
  return withUnit ? `${number} ${spec.abbreviation}` : number;
}

/** A canonical **miles** value in the given distance unit, optionally suffixed. */
export function distance(miles: number, unit: DistanceUnit, withUnit = false): string {
  const spec = distanceUnits[unit];
  const number = numberFormat('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  }).format(spec.fromMiles(miles));
  return withUnit ? `${number} ${spec.abbreviation}` : number;
}

/**
 * "3 minutes ago", falling back to a date once it stops being recent — the
 * last sync, the last backup. A time ahead of the clock (a skewed device)
 * reads as "just now", never a negative age. Moved from Settings (#93).
 */
export function describeSince(at: number | null, now: number = Date.now()): string {
  // Not a number reads as never, rather than as "Invalid Date".
  if (at === null || !Number.isFinite(at)) return 'not yet';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return new Date(at).toLocaleDateString();
}

/** "2021 Honda Civic" under a car's name, or nothing when only the year is known. Moved from Vehicles (#93). */
export function vehicleSubtitle(vehicle: { readonly year: number; readonly make: string; readonly model: string }): string {
  const parts = [String(vehicle.year), vehicle.make, vehicle.model].filter((p) => p !== '');
  const joined = parts.join(' ');
  return joined === String(vehicle.year) ? '' : joined;
}
