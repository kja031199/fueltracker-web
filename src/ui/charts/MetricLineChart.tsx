import type { ReactElement } from 'react';
import type { DateValuePoint } from '../../domain/models';
import { downsampled } from '../../domain/models';
import { chartSummary } from '../../domain/chartAccessibility';
import type { Metric } from '../../domain/metric';
import { hueFor } from '../../domain/metric';
import { ChartFrame } from './ChartFrame';
import { extentOf, linePath, niceTicks, plotBounds, scale } from './geometry';

interface Props {
  readonly title: string;
  readonly points: readonly DateValuePoint[];
  readonly metric: Metric;
  readonly unit: string;
  readonly formatValue: (value: number) => string;
  /** Drawn as a dashed rule. Computed over the full history, not the sample. */
  readonly average?: number | null;
}

const AREA = { width: 320, height: 160, left: 46, right: 8, top: 10, bottom: 18 };

/** Above this many points the drawn series is thinned; the maths is not. */
export const DOWNSAMPLE_THRESHOLD = 500;

/**
 * One metric over time.
 *
 * The series is **downsampled for drawing only** — a decade of fill-ups is
 * thousands of marks a phone cannot show and nobody can read — while every
 * statistic, the average rule included, still comes from the full history.
 * Thinning the data and then averaging the thinned copy would quietly report a
 * different number than the dashboard does.
 */
export function MetricLineChart({
  title,
  points,
  metric,
  unit,
  formatValue,
  average = null,
}: Props): ReactElement {
  const shown = downsampled(points, DOWNSAMPLE_THRESHOLD);
  // The summary describes the whole series, not the drawn sample.
  const summary = chartSummary(points, unit, formatValue);
  const { x0, x1, y0, y1 } = plotBounds(AREA);

  const values = shown.map((point) => point.value);
  const yExtent = extentOf(average === null ? values : [...values, average]);
  const xExtent = extentOf(shown.map((point) => point.date.getTime()));

  const placed = shown.map((point) => ({
    x: shown.length > 1 ? scale(point.date.getTime(), xExtent, x0, x1) : (x0 + x1) / 2,
    y: scale(point.value, yExtent, y0, y1),
  }));

  const rows = shown.map((point) => ({
    label: point.date.toLocaleDateString(),
    value: formatValue(point.value),
  }));

  const stroke = `var(--accent-${hueFor(metric)})`;

  return (
    <div className="card">
      <ChartFrame title={title} summary={summary} rows={rows} rowHeadings={['Date', unit]}>
        {points.length === 0 ? (
          <p className="empty" style={{ padding: '24px 0' }}>
            Not enough data yet.
          </p>
        ) : (
          <svg
            viewBox={`0 0 ${AREA.width} ${AREA.height}`}
            width="100%"
            focusable="false"
            aria-hidden="true"
            style={{ display: 'block', maxHeight: 200 }}
          >
            {niceTicks(yExtent).map((tick) => {
              const y = scale(tick, yExtent, y0, y1);
              return (
                <g key={tick}>
                  <line x1={x0} x2={x1} y1={y} y2={y} stroke="var(--separator)" strokeWidth={1} />
                  <text
                    x={x0 - 6}
                    y={y + 3}
                    textAnchor="end"
                    fontSize={9}
                    fill="var(--text-secondary)"
                  >
                    {formatValue(tick)}
                  </text>
                </g>
              );
            })}

            {average !== null && Number.isFinite(average) && (
              <line
                x1={x0}
                x2={x1}
                y1={scale(average, yExtent, y0, y1)}
                y2={scale(average, yExtent, y0, y1)}
                stroke="var(--text-secondary)"
                strokeWidth={1}
                strokeDasharray="4 4"
              />
            )}

            <path d={linePath(placed)} fill="none" stroke={stroke} strokeWidth={2} />

            {/* Point marks only while they stay distinguishable; past that they
                merge into a thick smear that reads as a wider line. */}
            {placed.length <= 60 &&
              placed.map((point, index) => (
                <circle key={shown[index]!.id} cx={point.x} cy={point.y} r={2.5} fill={stroke} />
              ))}
          </svg>
        )}
      </ChartFrame>
    </div>
  );
}
