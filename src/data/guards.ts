/**
 * The small checks every decoder of untrusted data makes — a row from the
 * account, a backup file, a link, a sharing document — written once (#91).
 *
 * They had been copied into five modules, and one name meant two things:
 * `finite` answered yes or no in three places, and gave back "the number, or
 * 0" in a fourth. Here each has one name that says which.
 */

import { boundText } from '../domain/textLimits';

/** A plain object to read fields from: not `null`, not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A number that is not `NaN` and not either infinity. */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Text, cut to `max` UTF-16 units when given — or `''` for anything that is
 * not text. Empty rather than `String(value)`: an object would otherwise be
 * kept as "[object Object]", which looks like real data and is worse than
 * nothing.
 */
export function textOr(value: unknown, max?: number): string {
  if (typeof value !== 'string') return '';
  return max === undefined ? value : boundText(value, max);
}

/** A finite number, or `fallback` for anything else. */
export function numberOr(value: unknown, fallback: number): number {
  return isFiniteNumber(value) ? value : fallback;
}
