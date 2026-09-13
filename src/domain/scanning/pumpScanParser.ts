/**
 * Turns raw OCR text lines from a gas pump display into a reading, ported from
 * `Shared/Scanning/PumpScanParser.swift`.
 *
 * Strategy, in order of trust:
 *
 * 1. **Labels** — lines like "GALLONS 8.712", or "PRICE/GAL" followed by a
 *    value on the next display line.
 * 2. **Arithmetic consistency** — a (total, gallons, price) triple where
 *    gallons × price ≈ total identifies all three even with no labels at all.
 * 3. **Derivation** — any two of the three yield the missing one.
 * 4. **Decimal heuristics** — pumps show price and gallons to three decimals;
 *    used only when exactly one candidate fits, because a guess that is wrong
 *    is worse than no answer.
 *
 * ## US-only by design
 *
 * The ranges below and the `9/10` fraction-of-a-cent notation are tuned to US
 * pumps, and this is deliberate rather than an oversight — the same caveat the
 * iOS app carries. Manual entry supports every unit; scanning does not. That
 * matters more here than upstream, because a web app's reach is wider than an
 * iPhone app's.
 */

/** Values read off a pump display. Any field may be absent. */
export interface PumpReading {
  readonly gallons: number | null;
  readonly pricePerGallon: number | null;
  readonly totalCost: number | null;
}

export const EMPTY_PUMP_READING: PumpReading = {
  gallons: null,
  pricePerGallon: null,
  totalCost: null,
};

/** Gallons and price are what the fill-up form needs; total is derived. */
export function isCompleteReading(reading: PumpReading): boolean {
  return reading.gallons !== null && reading.pricePerGallon !== null;
}

export function isEmptyReading(reading: PumpReading): boolean {
  return (
    reading.gallons === null && reading.pricePerGallon === null && reading.totalCost === null
  );
}

/** Plausible bands. Anything outside them is octane, an odometer, or noise. */
export const GALLONS_RANGE = { min: 0.3, max: 60.0 } as const;
export const PRICE_RANGE = { min: 1.5, max: 9.999 } as const;
export const TOTAL_RANGE = { min: 1.0, max: 500.0 } as const;

/**
 * Upper bound on the values fed to the O(n³) consistency search.
 *
 * A real pump or receipt shows a handful of numbers; a crafted, number-dense
 * image could yield hundreds, turning the cubic scan into a UI-freezing denial
 * of service. Real fills stay far under this, so accuracy is unaffected while
 * the worst case is bounded at roughly 64k iterations.
 */
export const MAX_TRIPLE_CANDIDATES = 40;

interface Range {
  readonly min: number;
  readonly max: number;
}

/** Inclusive on both ends, matching Swift's `a...b`. */
function inRange(value: number, range: Range): boolean {
  return value >= range.min && value <= range.max;
}

type Label = 'gallons' | 'price' | 'total';

interface ScannedNumber {
  readonly value: number;
  readonly fractionDigits: number;
}

interface MutableReading {
  gallons: number | null;
  pricePerGallon: number | null;
  totalCost: number | null;
}

/** "3.49 9/10" — the fraction-of-a-cent notation — means 3.499. */
function normalize(line: string): string {
  return line.toUpperCase().split(' 9/10').join('9').split('9/10').join('9');
}

function extractNumbers(line: string): ScannedNumber[] {
  const results: ScannedNumber[] = [];
  for (const match of line.matchAll(/([0-9]+)\.([0-9]{1,3})/g)) {
    const value = Number(`${match[1]}.${match[2]}`);
    if (Number.isFinite(value)) {
      results.push({ value, fractionDigits: match[2]!.length });
    }
  }
  return results;
}

function labelIn(line: string): Label | null {
  if (line.includes('/GAL') || line.includes('PER GAL') || line.includes('PRICE')) return 'price';
  if (line.includes('GALLON') || line.includes('GAL')) return 'gallons';
  if (line.includes('TOTAL') || line.includes('SALE') || line.includes('AMOUNT')) return 'total';
  return null;
}

/** First labelled value wins — a later "GALLONS 9.999" must not overwrite it. */
function assign(value: number, label: Label, reading: MutableReading): void {
  if (label === 'gallons' && inRange(value, GALLONS_RANGE)) {
    reading.gallons ??= value;
  } else if (label === 'price' && inRange(value, PRICE_RANGE)) {
    reading.pricePerGallon ??= value;
  } else if (label === 'total' && inRange(value, TOTAL_RANGE)) {
    reading.totalCost ??= value;
  }
}

/**
 * Swift's `.rounded()` rounds halves **away from zero**; `Math.round` rounds
 * them toward +∞. Every value here is positive so the two agree today, but the
 * helper is written faithfully rather than relying on that staying true.
 */
function roundHalfAwayFromZero(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

function round3(value: number): number {
  return roundHalfAwayFromZero(value * 1000) / 1000;
}

/**
 * Finds the (total, gallons, price) triple that best reconciles, and fills in
 * whatever the label pass missed.
 *
 * This is the step that reads an unlabelled display, and the one that makes a
 * receipt's grand total harmless: a total bundling tax or a car wash will not
 * reconcile with gallons × price, so the fuel line wins on its own arithmetic.
 */
function applyConsistentTriple(values: readonly number[], reading: MutableReading): void {
  const complete = reading.gallons !== null && reading.pricePerGallon !== null;
  if (complete && reading.totalCost !== null) return;

  // Only in-range values can form a valid triple; keeping just those and
  // capping the count bounds this cubic search against a number flood.
  const pool = values
    .filter(
      (v) => inRange(v, TOTAL_RANGE) || inRange(v, GALLONS_RANGE) || inRange(v, PRICE_RANGE),
    )
    .slice(0, MAX_TRIPLE_CANDIDATES);

  let best: { gallons: number; price: number; total: number; error: number } | null = null;
  for (let i = 0; i < pool.length; i += 1) {
    const total = pool[i]!;
    if (!inRange(total, TOTAL_RANGE)) continue;
    for (let j = 0; j < pool.length; j += 1) {
      if (j === i) continue;
      const gallons = pool[j]!;
      if (!inRange(gallons, GALLONS_RANGE)) continue;
      for (let k = 0; k < pool.length; k += 1) {
        if (k === i || k === j) continue;
        const price = pool[k]!;
        if (!inRange(price, PRICE_RANGE)) continue;
        const error = Math.abs(gallons * price - total);
        const tolerance = Math.max(0.05, total * 0.01);
        // Strict `<` keeps the FIRST best triple on a tie, matching the Swift.
        if (error <= tolerance && error < (best?.error ?? Number.POSITIVE_INFINITY)) {
          best = { gallons, price, total, error };
        }
      }
    }
  }

  if (best !== null) {
    reading.gallons ??= best.gallons;
    reading.pricePerGallon ??= best.price;
    reading.totalCost ??= best.total;
  }
}

function deriveMissingValue(reading: MutableReading): void {
  if (reading.gallons === null && reading.totalCost !== null && reading.pricePerGallon !== null) {
    if (reading.pricePerGallon > 0) {
      const gallons = round3(reading.totalCost / reading.pricePerGallon);
      if (inRange(gallons, GALLONS_RANGE)) reading.gallons = gallons;
    }
  }
  if (reading.pricePerGallon === null && reading.totalCost !== null && reading.gallons !== null) {
    if (reading.gallons > 0) {
      const price = round3(reading.totalCost / reading.gallons);
      if (inRange(price, PRICE_RANGE)) reading.pricePerGallon = price;
    }
  }
  if (reading.totalCost === null && reading.gallons !== null && reading.pricePerGallon !== null) {
    reading.totalCost = roundHalfAwayFromZero(reading.gallons * reading.pricePerGallon * 100) / 100;
  }
}

/**
 * Pumps display price and gallons with three decimals. Only trust that when
 * exactly one candidate fits the band — with two, refusing to answer beats
 * answering wrong.
 */
function applyDecimalHeuristics(numbers: readonly ScannedNumber[], reading: MutableReading): void {
  if (reading.pricePerGallon === null) {
    const candidates = numbers.filter(
      (n) => n.fractionDigits === 3 && inRange(n.value, PRICE_RANGE),
    );
    if (candidates.length === 1) reading.pricePerGallon = candidates[0]!.value;
  }
  if (reading.gallons === null) {
    const candidates = numbers.filter(
      (n) =>
        n.fractionDigits === 3 &&
        inRange(n.value, GALLONS_RANGE) &&
        n.value !== reading.pricePerGallon,
    );
    if (candidates.length === 1) reading.gallons = candidates[0]!.value;
  }
}

export function parsePump(rawLines: readonly string[]): PumpReading {
  const reading: MutableReading = { gallons: null, pricePerGallon: null, totalCost: null };
  const numbers: ScannedNumber[] = [];
  let pendingLabel: Label | null = null;

  for (const rawLine of rawLines) {
    const line = normalize(rawLine);
    const lineNumbers = extractNumbers(line);
    numbers.push(...lineNumbers);

    const label = labelIn(line);
    if (label !== null) {
      const first = lineNumbers[0];
      if (first !== undefined) {
        assign(first.value, label, reading);
        pendingLabel = null;
      } else {
        // Pumps often put the label and the value on separate display lines;
        // remember the label for the next number that turns up.
        pendingLabel = label;
      }
    } else if (pendingLabel !== null && lineNumbers[0] !== undefined) {
      assign(lineNumbers[0].value, pendingLabel, reading);
      pendingLabel = null;
    } else if (lineNumbers.length > 0) {
      pendingLabel = null;
    }
  }

  applyConsistentTriple(numbers.map((n) => n.value), reading);
  deriveMissingValue(reading);
  applyDecimalHeuristics(numbers, reading);
  deriveMissingValue(reading);

  return { ...reading };
}

/**
 * Field-wise overlay so a live scan keeps the best values seen so far instead
 * of flickering as OCR results come and go.
 */
export function mergePumpReadings(current: PumpReading, next: PumpReading): PumpReading {
  return {
    gallons: next.gallons ?? current.gallons,
    pricePerGallon: next.pricePerGallon ?? current.pricePerGallon,
    totalCost: next.totalCost ?? current.totalCost,
  };
}
