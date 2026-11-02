/**
 * How long a piece of text may be, everywhere it is stored.
 *
 * ## Why this exists
 *
 * Issue #50. `firestore.rules` bounds every text field, and before this nothing
 * on the client did — not the form, not the draft gate, not a restored backup.
 * So the app saved a 201-character station name without complaint, and the
 * account refused it. A push is one batch, so that one document failed the
 * whole upload; and the refusal carried the same code as being off the
 * allowlist, so an *allowed* owner was shown "This account does not have
 * access", with no way to reach the row that caused it.
 *
 * These numbers are the rules' numbers, keyed by the same field names, and
 * `data/rulesLimits.test.ts` reads `firestore.rules` to keep them equal.
 * Change one, change both — in the same pull request, rules deployed first.
 *
 * ## How length is measured
 *
 * In UTF-16 code units: JavaScript's `.length`, and — measured against the
 * emulator — what the rules' `string.size()` counts too. 200 `é` (400 UTF-8
 * bytes) are accepted; 150 emoji (150 code points, 300 units) are refused.
 * So a plain `.length` comparison agrees with the server exactly, and the
 * form's `maxLength`, which also counts units, does too.
 */
export const TEXT_LIMITS = {
  name: 200,
  make: 200,
  model: 200,
  station: 200,
  notes: 4000,
  fuelGrade: 40,
  submitterName: 200,
} as const;

export type TextField = keyof typeof TEXT_LIMITS;

/**
 * `value` shortened to at most `max` UTF-16 units — the same string when it
 * already fits.
 *
 * Shortened, never rejected: the policy `recordValidation` set for text from
 * the account, now applied on every path. A fill-up's odometer reading is what
 * the statistics are built on; losing it over an essay in the notes would be
 * the worse outcome.
 *
 * A cut that lands between the two halves of a surrogate pair drops the stray
 * half, so the result is always valid text — one unit short rather than one
 * broken character long.
 */
export function boundText(value: string, max: number): string {
  if (!(max > 0)) return '';
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}
