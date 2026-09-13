/**
 * Finds the odometer reading in OCR text from a dashboard photo, ported from
 * `Shared/Scanning/OdometerScanParser.swift`.
 *
 * The hard part is not reading a number — it is ignoring the other numbers an
 * instrument cluster loves to show: the clock, the outside temperature, the
 * trip meter, the speedometer, a battery percentage. So the parser strips the
 * shapes it recognises as *not* an odometer, then picks among what is left
 * using the vehicle's own history.
 *
 * Like the pump parser, this is **US-only by design**: the plausible range is
 * in miles.
 */

/** How the candidate sits against the vehicle's recorded history. */
export type OdometerValidation =
  /** Fits between the last reading and a plausible distance beyond it. */
  | { readonly kind: 'plausible'; readonly milesSinceLast: number }
  /** Nothing recorded yet to check against. */
  | { readonly kind: 'noHistory' }
  /** Odometers never run backwards — almost certainly a misread. */
  | { readonly kind: 'belowLastReading'; readonly last: number }
  /**
   * Far beyond a plausible tank-to-tank distance — possibly a misread, or a
   * long-forgotten logging gap. Worth a human look either way.
   */
  | { readonly kind: 'implausiblyFar'; readonly last: number; readonly miles: number };

export function isWarning(validation: OdometerValidation): boolean {
  return validation.kind === 'belowLastReading' || validation.kind === 'implausiblyFar';
}

/** A candidate reading with a verdict on whether it fits the history. */
export interface OdometerCandidate {
  readonly value: number;
  readonly validation: OdometerValidation;
}

const PLAUSIBLE_RANGE = { min: 10.0, max: 999_999.0 } as const;

/** Assumed distance between fills when there is no average to go on yet. */
export const DEFAULT_MILES_PER_FILL = 350.0;

export interface OdometerOptions {
  readonly previousOdometer?: number | null;
  readonly typicalMilesPerFill?: number | null;
  /**
   * Values already claimed by the pump parser on the same photo. Without this,
   * a receipt's gallons or total can be mistaken for a mileage reading.
   */
  readonly excluding?: readonly number[];
}

interface Candidate {
  readonly value: number;
  readonly isInteger: boolean;
}

function normalize(line: string): string {
  let text = line.toUpperCase();
  // Clocks: "12:45" must never become 1245.
  text = text.replace(/\d{1,2}:\d{2}/g, ' ');
  // Temperatures and percentages: "72°" / "72F" readouts, battery "80%".
  text = text.replace(/[0-9]+(\.[0-9]+)?\s?(°F?C?|%)/g, ' ');
  // Digit-grouping commas: "42,150" → "42150".
  text = text.replace(/(?<=\d),(?=\d{3}\b)/g, '');
  return text;
}

/**
 * Numbers that could be a mileage reading.
 *
 * A value with **two or more decimals is pump formatting** — money, gallons —
 * and never an odometer. It still has to be consumed *whole*, though: matching
 * only the integer part would let the tail digits leak out as phantom
 * candidates, which is how "3.499" once became a 99-mile odometer reading.
 */
function extractNumbers(line: string): Candidate[] {
  const results: Candidate[] = [];
  for (const match of line.matchAll(/([0-9]+)(?:\.([0-9]+))?/g)) {
    const integerPart = match[1]!;
    const fraction = match[2];
    if (fraction !== undefined) {
      // Exactly one decimal is trip-meter style and stays in the running.
      if (fraction.length === 1) {
        const value = Number(`${integerPart}.${fraction}`);
        if (Number.isFinite(value)) results.push({ value, isInteger: false });
      }
    } else {
      const value = Number(integerPart);
      if (Number.isFinite(value)) results.push({ value, isInteger: true });
    }
  }
  return results;
}

/** First-wins maximum, matching Swift's `max(by:)` on equal elements. */
function largest(candidates: readonly Candidate[]): Candidate {
  let best = candidates[0]!;
  for (const candidate of candidates) {
    if (best.value < candidate.value) best = candidate;
  }
  return best;
}

export function parseOdometer(
  rawLines: readonly string[],
  options: OdometerOptions = {},
): OdometerCandidate | null {
  const excluding = options.excluding ?? [];
  const previous = options.previousOdometer ?? null;

  let candidates: Candidate[] = [];
  for (const line of rawLines) {
    candidates.push(...extractNumbers(normalize(line)));
  }
  candidates = candidates.filter(
    (candidate) =>
      candidate.value >= PLAUSIBLE_RANGE.min &&
      candidate.value <= PLAUSIBLE_RANGE.max &&
      !excluding.some((excluded) => Math.abs(excluded - candidate.value) < 0.001),
  );
  if (candidates.length === 0) return null;

  if (previous === null) {
    // Without history the only heuristic left: the odometer is usually the
    // largest number on the cluster.
    return { value: largest(candidates).value, validation: { kind: 'noHistory' } };
  }

  const typical = options.typicalMilesPerFill ?? DEFAULT_MILES_PER_FILL;
  const expected = previous + typical;
  const upperBound = previous + Math.max(3_000, typical * 8);

  const feasible = candidates.filter((c) => c.value >= previous && c.value <= upperBound);
  if (feasible.length > 0) {
    // Main odometers display whole miles; a one-decimal value is usually the
    // trip meter. Prefer integers when both fit.
    const pool = feasible.some((c) => c.isInteger) ? feasible.filter((c) => c.isInteger) : feasible;
    let best = pool[0]!;
    for (const candidate of pool) {
      if (Math.abs(candidate.value - expected) < Math.abs(best.value - expected)) best = candidate;
    }
    return {
      value: best.value,
      validation: { kind: 'plausible', milesSinceLast: best.value - previous },
    };
  }

  // Nothing fits: surface the most informative failure rather than nothing at
  // all. Anything ahead of the last reading is "too far"; otherwise it ran
  // backwards, which an odometer cannot do.
  const ahead = candidates.filter((c) => c.value > previous);
  if (ahead.length > 0) {
    let nearest = ahead[0]!;
    for (const candidate of ahead) {
      if (candidate.value < nearest.value) nearest = candidate;
    }
    return {
      value: nearest.value,
      validation: { kind: 'implausiblyFar', last: previous, miles: nearest.value - previous },
    };
  }
  return {
    value: largest(candidates).value,
    validation: { kind: 'belowLastReading', last: previous },
  };
}

function rank(validation: OdometerValidation): number {
  switch (validation.kind) {
    case 'plausible':
      return 3;
    case 'noHistory':
      return 2;
    case 'implausiblyFar':
      return 1;
    case 'belowLastReading':
      return 0;
  }
}

/**
 * Frame-to-frame merge for live scanning: keep the highest-confidence candidate
 * seen, letting an equal-confidence reading refresh it so the display tracks
 * the latest frame rather than freezing on the first.
 */
export function preferredOdometer(
  current: OdometerCandidate | null,
  next: OdometerCandidate | null,
): OdometerCandidate | null {
  if (next === null) return current;
  if (current === null) return next;
  return rank(next.validation) >= rank(current.validation) ? next : current;
}
