/**
 * Spoken overviews of chart data, ported from
 * `Shared/Views/ChartAccessibility.swift`.
 *
 * Per-point labels let someone navigate individual marks; this gives them the
 * **gist of the whole series first** — its range, average, latest value and
 * direction — so they are not obliged to walk every point to learn that prices
 * went up.
 *
 * It matters more here than upstream. iOS pairs this with an audio graph, which
 * plays the shape of a series as sound; the web has no equivalent, so the
 * spoken summary and the data table beside each chart carry the whole load.
 */

import type { DateValuePoint } from './models';

/**
 * Within ±2% of where it started counts as flat.
 *
 * A threshold rather than a strict comparison because fuel prices wobble, and
 * announcing "trending up" for a tenth of a cent would make the word useless.
 */
const FLAT_BAND = 0.02;

/**
 * One sentence describing a series, or `null` when there is nothing to say.
 *
 * `format` renders a value the way the chart's axis does, so the summary and
 * the marks agree — a summary in gallons beside an axis in litres would be
 * worse than no summary.
 */
export function chartSummary(
  points: readonly DateValuePoint[],
  unit: string,
  format: (value: number) => string,
): string | null {
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

  if (points.length === 1) {
    return `One point, ${format(last.value)} ${unit}.`;
  }

  const average = total / points.length;

  let trend: string;
  if (last.value > first.value * (1 + FLAT_BAND)) trend = 'trending up';
  else if (last.value < first.value * (1 - FLAT_BAND)) trend = 'trending down';
  else trend = 'roughly flat';

  return (
    `${points.length} points, from ${format(low)} to ${format(high)} ${unit}, ` +
    `averaging ${format(average)}, latest ${format(last.value)}, ${trend}.`
  );
}
