/**
 * Average fuel price grouped by day of the week, ported from
 * `Shared/Statistics/WeekdayPricePattern.swift`.
 *
 * The question this answers is "what price do I tend to catch on a Tuesday" —
 * so the average is a **plain mean, not gallon-weighted**. A 20-gallon fill
 * says nothing more about that day's price than a 5-gallon one does.
 *
 * This is the first ported module whose behaviour depends on calendar and
 * locale, which is where a port quietly diverges. Two things are therefore
 * explicit parameters rather than reads of an ambient global: the week's first
 * day, and the locale used for day names. Upstream reads `Calendar.current` and
 * `DateFormatter()`; here they are options with deterministic defaults, so a
 * test asserts a literal expected order instead of recomputing its own
 * expectation from the platform — which is the only way the assertion can catch
 * a numbering mistake rather than merely a rotation one.
 */

import type { FuelEntryStats } from './models';
import { plainCurrency } from './format';
import type { UnitPreferences } from './units';
import { US, volume } from './units';

/** Average price per gallon for one day of the week. */
export interface WeekdayPrice {
  /** Calendar weekday: **1 = Sunday … 7 = Saturday**, matching the Swift. */
  readonly weekday: number;
  /** Localised short symbol for the chart axis, e.g. "Tue". */
  readonly symbol: string;
  /** Simple mean of the price per gallon paid on this weekday. */
  readonly averagePrice: number;
  readonly fillUpCount: number;
}

export interface WeekdayOptions {
  /**
   * The week's first day in **Calendar numbering** (1 = Sunday … 7 = Saturday).
   * Defaults to Sunday, matching a US calendar. Use
   * {@link firstWeekdayForLocale} to derive it.
   */
  readonly firstWeekday?: number;
  /** BCP 47 tag for day names. Defaults to `'en-US'`. */
  readonly locale?: string;
}

/** Defensive fallbacks; `Intl` always supplies these in practice. */
const FALLBACK_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const FALLBACK_FULL = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
];

/**
 * A week of real dates, Sunday first, used only as input to `Intl` so the day
 * names come from the platform rather than a hand-written table. 2025-01-05 is
 * a Sunday; the six days after it complete the week.
 */
const REFERENCE_WEEK = Array.from({ length: 7 }, (_, i) => new Date(2025, 0, 5 + i));

function weekdayNames(locale: string, width: 'short' | 'long'): string[] {
  try {
    const formatter = new Intl.DateTimeFormat(locale, { weekday: width });
    const names = REFERENCE_WEEK.map((date) => formatter.format(date));
    if (names.every((name) => name.length > 0)) return names;
  } catch {
    // Fall through to the English fallback.
  }
  return width === 'short' ? [...FALLBACK_SHORT] : [...FALLBACK_FULL];
}

/**
 * The locale's first weekday, in Calendar numbering.
 *
 * `Intl.Locale`'s week info uses **ISO numbering — 1 = Monday … 7 = Sunday** —
 * which is not the numbering anything else here uses, so it is converted. Get
 * this off by one and the whole week rotates; no assertion that reads the
 * platform's own answer would notice, which is why the ported test asserts a
 * literal order instead.
 */
export function firstWeekdayForLocale(locale: string): number {
  try {
    const info = new Intl.Locale(locale) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const firstDay = info.getWeekInfo?.().firstDay ?? info.weekInfo?.firstDay;
    if (typeof firstDay === 'number' && firstDay >= 1 && firstDay <= 7) {
      return firstDay === 7 ? 1 : firstDay + 1;
    }
  } catch {
    // Fall through.
  }
  // Sunday, matching the Swift's own default when a calendar offers nothing.
  return 1;
}

/**
 * Average price paid per gallon grouped by day of the week, ordered from the
 * week's first day. Only weekdays with at least one fill appear.
 *
 * An entry whose date is invalid produces a `NaN` weekday, matches no bucket,
 * and drops out silently — the same outcome as the Swift, where the grouping
 * key simply never equals 1…7.
 */
export function weekdayPrices(
  entries: readonly FuelEntryStats[],
  options: WeekdayOptions = {},
): WeekdayPrice[] {
  const firstWeekday = options.firstWeekday ?? 1;
  const symbols = weekdayNames(options.locale ?? 'en-US', 'short');

  const grouped = new Map<number, FuelEntryStats[]>();
  for (const entry of entries) {
    const weekday = entry.date.getDay() + 1;
    if (!Number.isFinite(weekday)) continue;
    const bucket = grouped.get(weekday);
    if (bucket === undefined) grouped.set(weekday, [entry]);
    else bucket.push(entry);
  }

  // 1…7 rotated so the week reads from its first day.
  const order = Array.from({ length: 7 }, (_, i) => ((firstWeekday - 1 + i) % 7) + 1);

  const result: WeekdayPrice[] = [];
  for (const weekday of order) {
    const fills = grouped.get(weekday);
    if (fills === undefined || fills.length === 0) continue;
    const total = fills.reduce((sum, entry) => sum + entry.pricePerGallon, 0);
    result.push({
      weekday,
      symbol: symbols[weekday - 1] ?? FALLBACK_SHORT[weekday - 1] ?? '',
      averagePrice: total / fills.length,
      fillUpCount: fills.length,
    });
  }
  return result;
}

/**
 * The cheapest weekday, or `null` with no data.
 *
 * Ties resolve to the **first day in the ordering above**, matching Swift's
 * `min(by:)`, which keeps the first of equal elements. The tie-break is
 * positional, so it has to be written deliberately — a `reduce` using `<=`
 * would silently keep the last instead.
 */
export function cheapestWeekday(
  entries: readonly FuelEntryStats[],
  options: WeekdayOptions = {},
): WeekdayPrice | null {
  return extreme(weekdayPrices(entries, options), (candidate, best) => candidate < best);
}

/** The priciest weekday, with the same first-wins tie-break. */
export function priciestWeekday(
  entries: readonly FuelEntryStats[],
  options: WeekdayOptions = {},
): WeekdayPrice | null {
  return extreme(weekdayPrices(entries, options), (candidate, best) => candidate > best);
}

function extreme(
  prices: readonly WeekdayPrice[],
  replaces: (candidate: number, best: number) => boolean,
): WeekdayPrice | null {
  let best: WeekdayPrice | null = null;
  for (const price of prices) {
    if (best === null || replaces(price.averagePrice, best.averagePrice)) best = price;
  }
  return best;
}

/** Enough history before a weekday pattern is worth showing at all. */
export const MIN_FILLS_FOR_INSIGHT = 4;
/** Below a one-cent spread the "pattern" is noise. */
export const MIN_INSIGHT_SPREAD_CENTS = 1;

export interface InsightOptions extends WeekdayOptions {
  readonly units?: UnitPreferences;
}

/**
 * Headline comparing the cheapest and priciest weekdays — shown only when the
 * pattern is worth trusting: at least two distinct weekdays, a handful of fills
 * overall, and at least a one-cent spread.
 *
 * The spread is converted to the user's volume unit, so a metric reader is told
 * what they save per litre rather than per gallon.
 *
 * ## One deliberate divergence from the Swift
 *
 * The spread is required to be **finite**. Upstream guards only with
 * `delta * 100 >= 1`, which is false for `NaN` but *true* for `+∞` — so an
 * infinite price produces the sentence "You pay about $∞/gal less on Tuesdays
 * than Fridays." The iOS app never shows it because `FuelEntryDraft` rejects
 * non-finite numbers at the write boundary, so the value cannot reach here; the
 * hole is latent rather than live. Since the whole point of that draft guard is
 * that a corrupted or crafted record must not "poison every statistic", the
 * port closes the second hole too rather than reproducing it.
 */
export function weekdayPriceInsight(
  entries: readonly FuelEntryStats[],
  options: InsightOptions = {},
): string | null {
  const prices = weekdayPrices(entries, options);
  if (prices.length < 2 || entries.length < MIN_FILLS_FOR_INSIGHT) return null;

  const cheapest = cheapestWeekday(entries, options);
  const priciest = priciestWeekday(entries, options);
  if (cheapest === null || priciest === null) return null;
  if (cheapest.weekday === priciest.weekday) return null;

  const delta = priciest.averagePrice - cheapest.averagePrice;
  // `!Number.isFinite` covers NaN as well; the cents test alone would not cover
  // +∞. See the divergence note above.
  if (!Number.isFinite(delta)) return null;
  if (!(delta * 100 >= MIN_INSIGHT_SPREAD_CENTS)) return null;

  const units = options.units ?? US;
  const locale = options.locale ?? 'en-US';
  const fullNames = weekdayNames(locale, 'long');
  const cheapName = fullNames[cheapest.weekday - 1] ?? '';
  const priceyName = fullNames[priciest.weekday - 1] ?? '';
  const unit = volume[units.volume];
  const perUnitDelta = plainCurrency(delta / unit.fromGallons(1), { locale });
  return `You pay about ${perUnitDelta}/${unit.abbreviation} less on ${cheapName}s than ${priceyName}s.`;
}
