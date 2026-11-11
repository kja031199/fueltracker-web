/**
 * How things are put into words on screen (#94).
 *
 * These were in `domain/format.ts`, which made the domain layer the place
 * English sentences were built: "just now", "partial fill", "the fill-up of …".
 * The domain now hands over values, and the screens phrase them here — which
 * is what would let them be translated. Numbers, money and dates are still
 * formatted by `domain/format.ts`, which has no words in it.
 */

import type { UnitPreferences } from '../domain/units';
import { countOf, distance, formatDate, US_STYLE, volume } from '../domain/format';

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
export function vehicleSubtitle(vehicle: {
  readonly year: number;
  readonly make: string;
  readonly model: string;
}): string {
  const parts = [String(vehicle.year), vehicle.make, vehicle.model].filter((p) => p !== '');
  const joined = parts.join(' ');
  return joined === String(vehicle.year) ? '' : joined;
}

/**
 * Who a person is shown as (#93): their name, else their email, else the
 * fallback. Trimmed, so a name of only spaces shows the email instead of a
 * blank. Written four times as `name || email` before.
 */
export function displayName(person: { readonly name: string; readonly email: string }, fallback = 'someone'): string {
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
export function verifiedName(person: { readonly name: string; readonly email: string }, fallback = 'someone'): string {
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
