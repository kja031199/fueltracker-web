import type { ReactElement } from 'react';
import type { MonthlyTotal } from '../../domain/fuelStatistics';
import { chartSummary } from '../../domain/chartAccessibility';
import type { Metric } from '../../domain/metric';
import { hueFor } from '../../domain/metric';
import { ChartFrame } from './ChartFrame';
import { extentOf, niceTicks, plotBounds, scale } from './geometry';

interface Props {
  readonly title: string;
  readonly totals: readonly MonthlyTotal[];
  readonly value: (total: MonthlyTotal) => number;
  readonly metric: Metric;
  readonly unit: string;
  readonly formatValue: (value: number) => string;
}

const AREA = { width: 320, height: 160, left: 46, right: 8, top: 10, bottom: 20 };

const MONTH = new Intl.DateTimeFormat('en-US', { month: 'narrow' });
const MONTH_LONG = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' });

/**
 * A month-by-month total, as bars.
 *
 * Bars are **zero-based**, unlike the line charts. A truncated bar lies about
 * proportion — twice the height has to mean twice the amount — which is the
 * whole reason to draw a bar rather than a point in the first place.
 */
export function MonthlyBarChart({
  title,
  totals,
  value,
  metric,
  unit,
  formatValue,
}: Props): ReactElement {
  const { x0, x1, y0, y1 } = plotBounds(AREA);
  const amounts = totals.map(value);
  const yExtent = extentOf(amounts, true);

  const summary = chartSummary(
    totals.map((total) => ({ id: String(total.month.getTime()), date: total.month, value: value(total) })),
    unit,
    formatValue,
  );

  const slot = totals.length === 0 ? 0 : (x1 - x0) / totals.length;
  const barWidth = Math.max(2, slot * 0.6);
  const baseline = scale(0, yExtent, y0, y1);

  const rows = totals.map((total) => ({
    label: MONTH_LONG.format(total.month),
    value: formatValue(value(total)),
  }));

  return (
    <div className="card">
      <ChartFrame title={title} summary={summary} rows={rows} rowHeadings={['Month', unit]}>
        {totals.length === 0 ? (
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

            {totals.map((total, index) => {
              const amount = value(total);
              const top = scale(amount, yExtent, y0, y1);
              const centre = x0 + slot * (index + 0.5);
              return (
                <g key={total.month.getTime()}>
                  <rect
                    x={centre - barWidth / 2}
                    y={Math.min(top, baseline)}
                    width={barWidth}
                    height={Math.max(1, Math.abs(baseline - top))}
                    rx={2}
                    fill={`var(--accent-${hueFor(metric)})`}
                  />
                  {/* Labels only while they will not overlap into mush. */}
                  {totals.length <= 12 && (
                    <text
                      x={centre}
                      y={AREA.height - 6}
                      textAnchor="middle"
                      fontSize={8}
                      fill="var(--text-secondary)"
                    >
                      {MONTH.format(total.month)}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        )}
      </ChartFrame>
    </div>
  );
}
