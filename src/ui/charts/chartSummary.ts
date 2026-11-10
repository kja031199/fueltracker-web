/**
 * A chart's series in one spoken sentence (#94): "3 points, from 24 to 36 MPG,
 * averaging 30, latest 36, trending up." The values come from
 * `domain/chartAccessibility.ts`; the words are the screen's.
 *
 * `format` renders a value the way the chart's axis does, so the summary and
 * the marks agree — a summary in gallons beside an axis in litres would be
 * worse than no summary.
 */

import type { DateValuePoint } from '../../domain/models';
import type { SeriesTrend } from '../../domain/chartAccessibility';
import { summarizeSeries } from '../../domain/chartAccessibility';

const TREND: Record<SeriesTrend, string> = {
  up: 'trending up',
  down: 'trending down',
  flat: 'roughly flat',
};

/** One sentence describing a series, or `null` when there is nothing to say. */
export function chartSummary(
  points: readonly DateValuePoint[],
  unit: string,
  format: (value: number) => string,
): string | null {
  const summary = summarizeSeries(points);
  if (summary === null) return null;
  // A single point says so rather than reciting statistics about itself.
  if (summary.count === 1) return `One point, ${format(summary.latest)} ${unit}.`;
  return (
    `${summary.count} points, from ${format(summary.low)} to ${format(summary.high)} ${unit}, ` +
    `averaging ${format(summary.average)}, latest ${format(summary.latest)}, ${TREND[summary.trend]}.`
  );
}
