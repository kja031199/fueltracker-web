/**
 * The reader's unit preference, and where it is kept.
 *
 * Storage stays canonical — miles, US gallons, US MPG — and this only decides
 * what is displayed and what typed numbers are converted from. A **browser**
 * preference (`preferences.ts`) rather than anything in the database, because
 * it is a per-device display choice, not user data: it should not sync, and
 * losing it costs nothing but a re-pick.
 *
 * Whether someone has been welcomed used to live here too, for want of a better
 * home; it is about the account, not units, and is in `onboarding.ts` now.
 */

import type { UnitPreferences } from '../domain/units';
import { unitPreferencesForLocale } from '../domain/units';
import { currencyForLocale, displayLocale, isCurrencyCode } from '../domain/format';
import { browserPreference, jsonCodec, readPreference, writePreference } from './preferences';

function isUnitPreferences(value: unknown): value is UnitPreferences {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    (candidate['volume'] === 'gallons' || candidate['volume'] === 'liters') &&
    (candidate['distance'] === 'miles' || candidate['distance'] === 'kilometers') &&
    (candidate['economy'] === 'mpg' ||
      candidate['economy'] === 'litersPer100km' ||
      candidate['economy'] === 'kmPerLiter')
  );
}

const UNITS = browserPreference('units', jsonCodec(isUnitPreferences));

/**
 * The stored preference, or one seeded from the browser's locale. A missing,
 * unreadable or hand-mangled value falls back rather than throwing on startup,
 * which would take the whole app down over a display setting.
 */
export function loadUnitPreferences(locale?: string): UnitPreferences {
  return (
    readPreference(UNITS) ??
    unitPreferencesForLocale(
      // Through `displayLocale`, so a missing or malformed browser language
      // reads as US English rather than crashing on startup (#94).
      locale ?? displayLocale(typeof navigator === 'undefined' ? undefined : navigator.language),
    )
  );
}

/**
 * A browser that refuses storage still gets a working session; the choice just
 * does not survive a reload.
 */
export function saveUnitPreferences(preferences: UnitPreferences): void {
  writePreference(UNITS, preferences);
}

const CURRENCY = browserPreference('currency', jsonCodec(isCurrencyCode));

/**
 * The currency amounts are shown in (#94): the one picked in Settings, else the
 * one the browser's locale implies. A browser preference like the units, and
 * for the same reason — it is how this device shows things, not data — so it
 * does not sync and is not in backups. A stored value that is not a currency
 * code (`isCurrencyCode`) is ignored rather than handed to `Intl`, which would
 * throw on it and take the screen down.
 */
export function loadCurrency(locale: string): string {
  return readPreference(CURRENCY) ?? currencyForLocale(locale);
}

export function saveCurrency(code: string): void {
  if (isCurrencyCode(code)) writePreference(CURRENCY, code);
}
