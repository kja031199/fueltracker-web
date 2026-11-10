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

import type { DistanceUnit, EconomyUnit, UnitPreferences, VolumeUnit } from './units';
import {
  distance as distanceUnits,
  economy as economyUnits,
  pricePerUnit,
  regionForLocale,
  volume as volumeUnits,
} from './units';

/** The two forms an English count needs: `# row was`, `# rows were`. */
export interface PluralForms {
  readonly one: string;
  readonly other: string;
}

/** English plural rules: the words are English, so English decides the form. */
const ENGLISH_PLURALS = new Intl.PluralRules('en');

/**
 * A count with the words that agree with it (#94): `1 row was`, `3 rows were`.
 * The `#` in the chosen form becomes the count, written in the reader's locale
 * (`1.234` in German).
 *
 * The *form* is chosen by English rules, never the reader's: the sentence is
 * English, and French counts 0 as singular ("0 row was"), while Polish and
 * Arabic have categories English has no words for. It used to be a
 * parenthesised "s", or a ternary on a count of one, written out by hand in
 * each sentence.
 */
export function countOf(count: number, forms: PluralForms, locale: string = US_STYLE.locale): string {
  const form = ENGLISH_PLURALS.select(count) === 'one' ? forms.one : forms.other;
  return form.replace('#', numberFormat(locale, { maximumFractionDigits: 0 }).format(count));
}

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

/**
 * How numbers, dates and money are shown (#94): the reader's locale, and the
 * currency they pay in. Display only — storage is canonical whatever this is.
 *
 * One locale for numbers *and* dates, so the two never disagree on a screen:
 * before, numbers were fixed to US English while dates followed the browser,
 * and money was always dollars beside the browser's own kilometres and litres.
 */
export interface DisplayStyle {
  /** A BCP 47 tag `Intl` supports. */
  readonly locale: string;
  /** An ISO 4217 code. */
  readonly currency: string;
}

/**
 * The default everywhere a style is optional. It reproduces, byte for byte,
 * what every function printed before there was a style, which is what keeps
 * the existing assertions valid (the same rule as units defaulting to `US`).
 */
export const US_STYLE: DisplayStyle = { locale: 'en-US', currency: 'USD' };

/** The currencies Settings offers: one per region above, sorted. */
export const CURRENCIES: readonly string[] = [...new Set(Object.values(REGION_CURRENCY))].sort();

/**
 * A well-formed ISO 4217 code: exactly three capital letters. `Intl` accepts
 * any such code (unknown ones print as the code itself) and throws on anything
 * else, so a stored value is checked here rather than trusted to it.
 */
export function isCurrencyCode(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value);
}

/**
 * The locale to display in, from the browser's language: that tag if `Intl`
 * supports it, otherwise US English. A blank, malformed or absurdly long
 * value — `navigator.language` is the browser's, but a test or an odd browser
 * can hand over anything — never reaches a formatter, where it would throw.
 */
export function displayLocale(language: unknown): string {
  if (typeof language !== 'string' || language === '' || language.length > 100) return US_STYLE.locale;
  try {
    const [supported] = Intl.NumberFormat.supportedLocalesOf([language]);
    return supported === undefined ? US_STYLE.locale : language;
  } catch {
    return US_STYLE.locale;
  }
}

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
export function economy(mpg: number, unit: EconomyUnit, locale = US_STYLE.locale): string | null {
  const converted = economyUnits[unit].fromMPG(mpg);
  if (converted === null) return null;
  return numberFormat(locale, {
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
export function volume(gallons: number, unit: VolumeUnit, withUnit = false, locale = US_STYLE.locale): string {
  const spec = volumeUnits[unit];
  const number = numberFormat(locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  }).format(spec.fromGallons(gallons));
  return withUnit ? `${number} ${spec.abbreviation}` : number;
}

/** A canonical **miles** value in the given distance unit, optionally suffixed. */
export function distance(miles: number, unit: DistanceUnit, withUnit = false, locale = US_STYLE.locale): string {
  const spec = distanceUnits[unit];
  const number = numberFormat(locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  }).format(spec.fromMiles(miles));
  return withUnit ? `${number} ${spec.abbreviation}` : number;
}

const dateFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * A day, as the reader's locale writes one: `5/1/2026`, `1.5.2026`,
 * `01/05/2026` (#94). One cached `Intl.DateTimeFormat` per locale, like
 * `numberFormat`. With the default locale it prints exactly what
 * `toLocaleDateString('en-US')` does, and a time that is not a finite number
 * reads `Invalid Date`, as `toLocaleDateString` did, rather than throwing.
 */
export function formatDate(at: number, locale = US_STYLE.locale): string {
  if (!Number.isFinite(at)) return 'Invalid Date';
  let formatter = dateFormatters.get(locale);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(locale);
    if (dateFormatters.size >= MAX_FORMATTERS) dateFormatters.clear();
    dateFormatters.set(locale, formatter);
  }
  return formatter.format(at);
}

/**
 * "3 minutes ago", falling back to a date once it stops being recent — the
 * last sync, the last backup. A time ahead of the clock (a skewed device)
 * reads as "just now", never a negative age. Moved from Settings (#93).
 */
export function describeSince(at: number | null, now: number = Date.now(), locale = US_STYLE.locale): string {
  // Not a number reads as never, rather than as "Invalid Date".
  if (at === null || !Number.isFinite(at)) return 'not yet';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return countOf(minutes, { one: '# minute ago', other: '# minutes ago' }, locale);
  const hours = Math.round(minutes / 60);
  if (hours < 24) return countOf(hours, { one: '# hour ago', other: '# hours ago' }, locale);
  return formatDate(at, locale);
}

/** "2021 Honda Civic" under a car's name, or nothing when only the year is known. Moved from Vehicles (#93). */
export function vehicleSubtitle(vehicle: { readonly year: number; readonly make: string; readonly model: string }): string {
  const parts = [String(vehicle.year), vehicle.make, vehicle.model].filter((p) => p !== '');
  const joined = parts.join(' ');
  return joined === String(vehicle.year) ? '' : joined;
}

/**
 * Who a person is shown as (#93): their name, else their email, else the
 * fallback. Trimmed, so a name of only spaces shows the email instead of a
 * blank. Written four times as `name || email` before.
 */
export function displayName(
  person: { readonly name: string; readonly email: string },
  fallback = 'someone',
): string {
  return person.name.trim() || person.email.trim() || fallback;
}

/**
 * Who a person who shares a car is (#81): the name they chose, **with** the
 * email Google verified — `Sam (sam@example.com)`.
 *
 * A name is whatever a person typed, so a member could call themselves the
 * owner and their rows would read as the owner's. The email can't be chosen:
 * the rules let a member join only with their own verified address. So it is
 * always shown, and a name never stands in for it — not even one that looks
 * like an email. Just the email when the name is blank or the same address.
 */
export function verifiedName(
  person: { readonly name: string; readonly email: string },
  fallback = 'someone',
): string {
  const name = person.name.trim();
  const email = person.email.trim();
  if (email === '') return name || fallback;
  if (name === '' || name.toLowerCase() === email.toLowerCase()) return email;
  return `${name} (${email})`;
}

/**
 * The grey line under a fill-up (#93): volume, distance and grade in the
 * reader's units, then what is unusual about it. "Missed previous" only where
 * asked — it is a fact about the reader's own log, which a fill-up sent by
 * link does not have.
 */
export function fillUpFacts(
  entry: {
    readonly gallons: number;
    readonly odometer: number;
    readonly fuelGrade: string;
    readonly isFullTank: boolean;
    readonly missedPreviousFillUp?: boolean;
  },
  units: UnitPreferences,
  options: { readonly missed?: boolean; readonly locale?: string } = {},
): string[] {
  const locale = options.locale ?? US_STYLE.locale;
  const facts = [
    volume(entry.gallons, units.volume, true, locale),
    distance(entry.odometer, units.distance, true, locale),
    entry.fuelGrade,
  ];
  if (!entry.isFullTank) facts.push('partial fill');
  if (options.missed === true && entry.missedPreviousFillUp === true) facts.push('missed previous');
  return facts;
}

/**
 * The year typed when adding a car (#93: moved out of Vehicles). Read as its
 * leading whole number, as it always has been; blank or nonsense is this
 * year rather than a stored NaN.
 */
export function vehicleYear(text: string, now: Date = new Date()): number {
  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) ? parsed : now.getFullYear();
}

/**
 * Which fill-up a row's buttons are for (#95): "the fill-up of 05/01/2026 at
 * 10,000 mi". A list of buttons all named "Edit" is a list of guesses to a
 * screen reader. The odometer reading is part of it so that two fill-ups on
 * one day are still two names.
 */
export function fillUpName(
  entry: { readonly date: number; readonly odometer: number },
  units: UnitPreferences,
  locale = US_STYLE.locale,
): string {
  return `the fill-up of ${formatDate(entry.date, locale)} at ${distance(entry.odometer, units.distance, true, locale)}`;
}
