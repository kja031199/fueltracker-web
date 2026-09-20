/**
 * Whether an OCR reading is trustworthy enough to put in front of someone.
 *
 * ## Why this exists
 *
 * Measured against degraded photographs of a receipt, the parser alone recovered
 * the right numbers 10 times out of 16 — but three of the six failures were
 * **silently wrong** rather than empty: a perspective-skewed shot produced
 * 16.234 gallons instead of 10.234, and another produced 53.499. Both sit
 * comfortably inside the plausible range, so nothing downstream would question
 * them, and 16 gallons instead of 10 would quietly wreck a segment's economy.
 *
 * Requiring the three numbers to **corroborate each other** changes that. A
 * misread digit almost always breaks the arithmetic, and on the same sixteen
 * images this took silently-wrong from three to one — the survivor being a
 * price of 3.49 against 3.499, a tenth of a cent. Five images are declined
 * outright, which is the honest answer to "we could not read it".
 *
 * Declining is cheap. Being confidently wrong is not.
 */

import type { PumpReading } from './pumpScanParser';

/**
 * The reconciliation tolerance, matching the pump parser's own triple search:
 * a cent either way, or 1% on larger totals.
 */
export function reconciles(gallons: number, pricePerGallon: number, totalCost: number): boolean {
  const error = Math.abs(gallons * pricePerGallon - totalCost);
  return error <= Math.max(0.05, totalCost * 0.01);
}

/** Every number the OCR text actually contained, in the parser's own shape. */
export function numbersIn(lines: readonly string[]): number[] {
  const found: number[] = [];
  for (const line of lines) {
    for (const match of line.toUpperCase().matchAll(/([0-9]+)\.([0-9]{1,3})/g)) {
      const value = Number(`${match[1]}.${match[2]}`);
      if (Number.isFinite(value)) found.push(value);
    }
  }
  return found;
}

/** Whether `value` is one of the numbers actually printed on the receipt. */
function wasRead(value: number, observed: readonly number[]): boolean {
  return observed.some((seen) => Math.abs(seen - value) < 0.0005);
}

/**
 * True when all three values were **independently read** and they agree.
 *
 * Both halves are load-bearing, and the second one was missing at first. The
 * pump parser *derives* a missing third value from the other two — given 16.234
 * gallons and a $35.81 total it computes $2.206 a gallon — and that derived
 * value multiplies back out perfectly, because it was calculated to. Checking
 * only the arithmetic would wave through exactly the misread this rule exists
 * to stop.
 *
 * So the check is against the numbers the OCR actually saw: a value the parser
 * invented cannot corroborate the ones it was invented from.
 */
export function isCorroborated(reading: PumpReading, observed: readonly number[]): boolean {
  const { gallons, pricePerGallon, totalCost } = reading;
  if (gallons === null || pricePerGallon === null || totalCost === null) return false;
  if (!Number.isFinite(gallons) || !Number.isFinite(pricePerGallon)) return false;
  if (!Number.isFinite(totalCost)) return false;
  if (!wasRead(gallons, observed)) return false;
  if (!wasRead(pricePerGallon, observed)) return false;
  if (!wasRead(totalCost, observed)) return false;
  return reconciles(gallons, pricePerGallon, totalCost);
}
