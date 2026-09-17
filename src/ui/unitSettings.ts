/**
 * The reader's unit preference, and where it is kept.
 *
 * Storage stays canonical — miles, US gallons, US MPG — and this only decides
 * what is displayed and what typed numbers are converted from. Kept in
 * `localStorage` rather than in the database because it is a per-browser
 * display choice, not user data: it should not sync, and losing it costs
 * nothing but a re-pick.
 */

import type { UnitPreferences } from '../domain/units';
import { unitPreferencesForLocale } from '../domain/units';

const STORAGE_KEY = 'fueltracker.units';

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

/**
 * The stored preference, or one seeded from the browser's locale.
 *
 * Every read is defensive: storage can be unavailable (private mode, blocked
 * cookies), and a stored value can be anything at all if it was hand-edited or
 * written by an older version. A bad value falls back rather than throwing on
 * startup, which would take the whole app down over a display setting.
 */
export function loadUnitPreferences(locale?: string): UnitPreferences {
  const fallback = unitPreferencesForLocale(
    locale ?? (typeof navigator === 'undefined' ? 'en-US' : navigator.language),
  );
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    return isUnitPreferences(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function saveUnitPreferences(preferences: UnitPreferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // A browser that refuses storage still gets a working session; the choice
    // just does not survive a reload.
  }
}

const ONBOARDED_KEY = 'fueltracker.hasOnboarded';

export function loadHasOnboarded(): boolean {
  try {
    return localStorage.getItem(ONBOARDED_KEY) === 'true';
  } catch {
    return false;
  }
}

export function saveHasOnboarded(): void {
  try {
    localStorage.setItem(ONBOARDED_KEY, 'true');
  } catch {
    // See above — not worth failing a first run over.
  }
}
