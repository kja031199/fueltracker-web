import type { DateValuePoint, FuelEntryStats } from './models';
import { totalCost } from './models';

/**
 * All dashboard statistics, computed once from a set of fuel entries. Ported
 * from `Shared/Statistics/FuelStatistics.swift`.
 *
 * MPG is calculated the way Fuelly does it: distance driven between two
 * full-tank fill-ups divided by all fuel added in that span. Partial fills
 * contribute their gallons to the next full-tank segment rather than producing
 * a (misleading) MPG number of their own.
 */

/** A computed MPG data point for one full-tank fill-up. */
export interface MPGPoint {
  readonly id: string;
  readonly date: Date;
  readonly mpg: number;
  readonly miles: number;
  readonly gallons: number;
}

/** A month's worth of aggregated fill-up data. */
export interface MonthlyTotal {
  readonly month: Date;
  readonly totalSpent: number;
  readonly totalGallons: number;
  readonly miles: number;
  readonly fillUpCount: number;
}

export interface PricePoint {
  readonly id: string;
  readonly date: Date;
  readonly pricePerGallon: number;
}

export interface OdometerPoint {
  readonly id: string;
  readonly date: Date;
  readonly odometer: number;
}

/** Segments above this are physically absurd regardless of vehicle history. */
export const ABSURD_MPG = 120;
/** A segment this many times the median suggests an unlogged fill-up. */
export const SUSPECT_MEDIAN_MULTIPLE = 1.75;
/** The relative rule needs this much history before it can know the norm. */
export const MIN_POINTS_FOR_RELATIVE_SUSPECT = 3;

export interface FuelStatistics {
  /** Input entries, **sorted by odometer ascending** (not by date). */
  readonly entries: readonly FuelEntryStats[];
  readonly mpgPoints: readonly MPGPoint[];
  readonly pricePoints: readonly PricePoint[];
  readonly odometerPoints: readonly OdometerPoint[];
  readonly monthlyTotals: readonly MonthlyTotal[];
  readonly suspectSegmentIds: ReadonlySet<string>;

  mpgFor(entryId: string): number | null;
  isSuspectSegment(entryId: string): boolean;
  /** Entries with suspect segments, newest first. */
  readonly suspectEntries: readonly FuelEntryStats[];
  readonly medianMPG: number | null;

  readonly mpgSeries: readonly DateValuePoint[];
  readonly priceSeries: readonly DateValuePoint[];
  readonly odometerSeries: readonly DateValuePoint[];

  readonly fillUpCount: number;
  readonly totalSpent: number;
  readonly totalGallons: number;
  readonly averageMPG: number | null;
  readonly lastMPG: number | null;
  readonly bestMPG: number | null;
  readonly worstMPG: number | null;
  readonly averagePricePerGallon: number | null;
  readonly lastPricePerGallon: number | null;
  readonly milesTracked: number;
  readonly costPerMile: number | null;
  readonly averageFillUpCost: number | null;
  readonly averageGallonsPerFillUp: number | null;
  readonly averageMonthlySpend: number | null;
  readonly averageMilesBetweenFillUps: number | null;
}

/** The upper median — `sorted[count / 2]` with integer division, no averaging
 *  of the two middle values on an even count. Matches the Swift exactly;
 *  changing it shifts every suspect threshold. */
function upperMedian(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

/** Local-midnight of the first of the entry's month, matching Swift's
 *  `Calendar.current.dateComponents([.year, .month])`. Local, not UTC. */
function monthKey(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function computeFuelStatistics(input: readonly FuelEntryStats[]): FuelStatistics {
  const entries = [...input].sort((a, b) => a.odometer - b.odometer);

  // --- MPG segments between full-tank fills -------------------------------
  const mpgPoints: MPGPoint[] = [];
  const mpgById = new Map<string, number>();
  let baseline: FuelEntryStats | null = null;
  let gallonsSinceBaseline = 0;

  for (const entry of entries) {
    if (entry.missedPreviousFillUp) {
      // An unlogged fill sits before this entry, so no segment can end here —
      // restart the chain instead. Its fuel still counts toward spending; it
      // just can't produce an MPG.
      baseline = entry.isFullTank ? entry : null;
      gallonsSinceBaseline = 0;
      continue;
    }
    if (baseline !== null) {
      gallonsSinceBaseline += entry.gallons;
      if (entry.isFullTank) {
        const miles = entry.odometer - baseline.odometer;
        if (miles > 0 && gallonsSinceBaseline > 0) {
          const mpg = miles / gallonsSinceBaseline;
          mpgPoints.push({
            id: entry.id,
            date: entry.date,
            mpg,
            miles,
            gallons: gallonsSinceBaseline,
          });
          mpgById.set(entry.id, mpg);
        }
        // Deliberately OUTSIDE the guard: when a segment is skipped (zero
        // distance, zero gallons) the baseline still advances and the counter
        // still resets, so the next segment measures *from* this entry rather
        // than across it.
        baseline = entry;
        gallonsSinceBaseline = 0;
      }
    } else if (entry.isFullTank) {
      // First full tank is the baseline; it has no MPG of its own.
      baseline = entry;
      gallonsSinceBaseline = 0;
    }
  }

  // --- Suspect segments ---------------------------------------------------
  // Two independent rules, union'd. Every comparison is strictly `>`.
  const suspectSegmentIds = new Set<string>();
  if (mpgPoints.length >= MIN_POINTS_FOR_RELATIVE_SUSPECT) {
    const median = upperMedian(mpgPoints.map((p) => p.mpg));
    if (median !== null) {
      for (const p of mpgPoints) {
        if (p.mpg > median * SUSPECT_MEDIAN_MULTIPLE) suspectSegmentIds.add(p.id);
      }
    }
  }
  for (const p of mpgPoints) {
    if (p.mpg > ABSURD_MPG) suspectSegmentIds.add(p.id);
  }

  // --- Series -------------------------------------------------------------
  // Price keeps odometer order; the odometer series is re-sorted by DATE.
  const pricePoints: PricePoint[] = entries.map((e) => ({
    id: e.id,
    date: e.date,
    pricePerGallon: e.pricePerGallon,
  }));

  const odometerPoints: OdometerPoint[] = [...entries]
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .map((e) => ({ id: e.id, date: e.date, odometer: e.odometer }));

  // --- Monthly rollups ----------------------------------------------------
  const buckets = new Map<number, FuelEntryStats[]>();
  for (const entry of entries) {
    const key = monthKey(entry.date).getTime();
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [entry]);
    else bucket.push(entry);
  }
  const monthlyTotals: MonthlyTotal[] = [...buckets.entries()]
    .map(([key, monthEntries]) => {
      const odometers = monthEntries.map((e) => e.odometer);
      // Miles are the span WITHIN the month, so distance driven across a
      // month boundary belongs to neither bucket.
      const span = Math.max(...odometers) - Math.min(...odometers);
      return {
        month: new Date(key),
        totalSpent: monthEntries.reduce((sum, e) => sum + totalCost(e), 0),
        totalGallons: monthEntries.reduce((sum, e) => sum + e.gallons, 0),
        miles: span,
        fillUpCount: monthEntries.length,
      };
    })
    .sort((a, b) => a.month.getTime() - b.month.getTime());

  // --- KPIs ---------------------------------------------------------------
  const fillUpCount = entries.length;
  const totalSpent = entries.reduce((sum, e) => sum + totalCost(e), 0);
  const totalGallons = entries.reduce((sum, e) => sum + e.gallons, 0);

  const segmentMiles = mpgPoints.reduce((sum, p) => sum + p.miles, 0);
  const segmentGallons = mpgPoints.reduce((sum, p) => sum + p.gallons, 0);
  const averageMPG = segmentGallons > 0 ? segmentMiles / segmentGallons : null;

  const first = entries[0];
  const last = entries[entries.length - 1];
  const milesTracked = first !== undefined && last !== undefined ? last.odometer - first.odometer : 0;

  let costPerMile: number | null = null;
  if (milesTracked > 0) {
    // Fuel that moved the car across the tracked span is everything after the
    // first (baseline) fill.
    const spent = entries.slice(1).reduce((sum, e) => sum + totalCost(e), 0);
    if (spent > 0) costPerMile = spent / milesTracked;
  }

  // Swift's `max(by:)` keeps the FIRST of equal maxima; mirror that by only
  // replacing on a strictly later date.
  let latestByDate: FuelEntryStats | null = null;
  for (const e of entries) {
    if (latestByDate === null || latestByDate.date.getTime() < e.date.getTime()) latestByDate = e;
  }

  let averageMonthlySpend: number | null = null;
  if (entries.length > 0) {
    const times = entries.map((e) => e.date.getTime());
    const earliest = Math.min(...times);
    const latest = Math.max(...times);
    if (earliest < latest) {
      const days = (latest - earliest) / 86_400_000;
      if (days >= 1) averageMonthlySpend = (totalSpent / days) * 30;
    }
  }

  const mpgValues = mpgPoints.map((p) => p.mpg);

  return {
    entries,
    mpgPoints,
    pricePoints,
    odometerPoints,
    monthlyTotals,
    suspectSegmentIds,

    mpgFor: (entryId) => mpgById.get(entryId) ?? null,
    isSuspectSegment: (entryId) => suspectSegmentIds.has(entryId),
    suspectEntries: entries
      .filter((e) => suspectSegmentIds.has(e.id))
      .sort((a, b) => b.date.getTime() - a.date.getTime()),
    medianMPG: upperMedian(mpgValues),

    mpgSeries: mpgPoints.map((p) => ({ id: p.id, date: p.date, value: p.mpg })),
    priceSeries: pricePoints.map((p) => ({ id: p.id, date: p.date, value: p.pricePerGallon })),
    odometerSeries: odometerPoints.map((p) => ({ id: p.id, date: p.date, value: p.odometer })),

    fillUpCount,
    totalSpent,
    totalGallons,
    averageMPG,
    lastMPG: mpgPoints.length > 0 ? (mpgPoints[mpgPoints.length - 1]?.mpg ?? null) : null,
    bestMPG: mpgValues.length > 0 ? Math.max(...mpgValues) : null,
    worstMPG: mpgValues.length > 0 ? Math.min(...mpgValues) : null,
    averagePricePerGallon: totalGallons > 0 ? totalSpent / totalGallons : null,
    lastPricePerGallon: latestByDate?.pricePerGallon ?? null,
    milesTracked,
    costPerMile,
    averageFillUpCost: fillUpCount > 0 ? totalSpent / fillUpCount : null,
    averageGallonsPerFillUp: fillUpCount > 0 ? totalGallons / fillUpCount : null,
    averageMonthlySpend,
    averageMilesBetweenFillUps: entries.length > 1 ? milesTracked / (entries.length - 1) : null,
  };
}
