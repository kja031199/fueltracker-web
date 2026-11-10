/**
 * The gist of a chart's series, ported from `Shared/Views/ChartAccessibility.swift`.
 *
 * Per-point labels let someone navigate individual marks; the summary gives
 * them the **gist of the whole series first** — its range, average, latest
 * value and direction — so they are not obliged to walk every point to learn
 * that prices went up.
 *
 * It matters more here than upstream. iOS pairs this with an audio graph, which
 * plays the shape of a series as sound; the web has no equivalent, so the
 * spoken summary and the data table beside each chart carry the whole load.
 *
 * This works out the **values** (#94); `ui/charts/chartSummary.ts` puts them
 * into the sentence a screen reader hears. It used to build the sentence here,
 * which put English in the domain layer.
 */

import type { DateValuePoint } from './models';

/**
 * Within ±2% of where it started counts as flat.
 *
 * A threshold rather than a strict comparison because fuel prices wobble, and
 * announcing "trending up" for a tenth of a cent would make the word useless.
 */
const FLAT_BAND = 0.02;

export type SeriesTrend = 'up' | 'down' | 'flat';

/** What a series amounts to. A single point has `count` 1 and no trend worth saying. */
export interface SeriesSummary {
  readonly count: number;
  readonly low: number;
  readonly high: number;
  readonly average: number;
  readonly latest: number;
  readonly trend: SeriesTrend;
}

/** The gist of a series, or `null` when there is nothing to say. */
export function summarizeSeries(points: readonly DateValuePoint[]): SeriesSummary | null {
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) return null;

  // Looped rather than `Math.min(...values)`: spreading passes every element
  // as an argument and throws past roughly a hundred thousand of them. Charts
  // downsample to 500 points for *display*, but the summary describes whatever
  // series it is handed, which may be a decade of fill-ups.
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  let total = 0;
  for (const point of points) {
    if (point.value < low) low = point.value;
    if (point.value > high) high = point.value;
    total += point.value;
  }

  let trend: SeriesTrend;
  if (last.value > first.value * (1 + FLAT_BAND)) trend = 'up';
  else if (last.value < first.value * (1 - FLAT_BAND)) trend = 'down';
  else trend = 'flat';

  return { count: points.length, low, high, average: total / points.length, latest: last.value, trend };
}
