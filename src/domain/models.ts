import type { FuelGrade } from './fuelGrade';

/**
 * The fields the statistics layer reads. Narrower than a stored record on
 * purpose: statistics never needs the station, notes, coordinates or receipt,
 * so tests can build fixtures from seven fields instead of a dozen, and the
 * memo key below has an obvious, auditable definition.
 */
export interface FuelEntryStats {
  readonly id: string;
  readonly date: Date;
  readonly odometer: number;
  readonly gallons: number;
  readonly pricePerGallon: number;
  readonly isFullTank: boolean;
  readonly missedPreviousFillUp: boolean;
}

/** A stored fill-up. */
export interface FuelEntry extends FuelEntryStats {
  readonly vehicleId: string;
  readonly fuelGrade: FuelGrade;
  readonly station: string;
  readonly notes: string;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly receiptImageData: Uint8Array | null;
}

/** Total cost is always derived from gallons × price, never stored. */
export function totalCost(entry: Pick<FuelEntryStats, 'gallons' | 'pricePerGallon'>): number {
  return entry.gallons * entry.pricePerGallon;
}

/**
 * A single (date, value) sample in a metric's time series.
 *
 * Lives with the models rather than with the charts that draw it, so the
 * statistics layer — which produces these — depends on nothing above it.
 */
export interface DateValuePoint {
  readonly id: string;
  readonly date: Date;
  readonly value: number;
}

/**
 * The series with each value passed through `transform`, preserving ids and
 * dates. Used to convert a canonical series (e.g. MPG) into a non-linear
 * display unit (e.g. L/100km), where relabelling the axis isn't enough because
 * the curve's shape changes.
 */
export function mapValues(
  series: readonly DateValuePoint[],
  transform: (value: number) => number,
): DateValuePoint[] {
  return series.map((p) => ({ id: p.id, date: p.date, value: transform(p.value) }));
}

/**
 * Evenly reduces the series to at most `max` points for **display**, always
 * keeping the first and last and picking real samples (no synthetic
 * averaging), so a chart isn't handed thousands of marks. Returns the series
 * unchanged when it's already at or under `max`. Statistics are computed from
 * the full set elsewhere and are unaffected.
 */
export function downsampled(series: readonly DateValuePoint[], max: number): DateValuePoint[] {
  if (max < 2 || series.length <= max) return [...series];
  const step = (series.length - 1) / (max - 1);
  const result: DateValuePoint[] = [];
  let lastIndex = -1;
  for (let i = 0; i < max; i++) {
    // Swift's `.rounded()` is half-away-from-zero; JS `Math.round` is
    // half-up. Identical for the non-negative values produced here.
    const index = Math.round(i * step);
    if (index !== lastIndex) {
      const point = series[index];
      if (point !== undefined) result.push(point);
      lastIndex = index;
    }
  }
  return result;
}
