/**
 * Number formatting for display, ported from `Shared/Support/Formatters.swift`.
 *
 * **Deliberately one function.** Upstream's `Format` enum has a dozen helpers,
 * but only `plainCurrency` has a caller in the domain layer — the weekday price
 * insight builds a sentence around it. The rest describe UI that does not exist
 * here yet and will port in Phase 3 alongside the screens that need them.
 * Untested formatters with no callers are exactly the dead weight this phase is
 * meant to avoid.
 */

import { regionForLocale } from './units';

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
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}
