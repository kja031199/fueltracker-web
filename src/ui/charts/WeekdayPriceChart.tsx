import type { ReactElement } from 'react';
import type { WeekdayPrice } from '../../domain/weekdayPricePattern';
import { ChartFrame } from './ChartFrame';
import { extentOf, niceTicks, plotBounds, scale } from './geometry';

interface Props {
  readonly prices: readonly WeekdayPrice[];
  readonly cheapestWeekday: number | null;
  readonly formatPrice: (value: number) => string;
}

const AREA = { width: 320, height: 150, left: 52, right: 8, top: 10, bottom: 20 };

/**
 * Average price by day of the week, as a dot plot with a **zoomed axis**.
 *
 * Deliberately not bars. Gas is never $0, so a zero-based bar chart buries the
 * cent-level differences that are the entire point — while a *truncated* bar
 * exaggerates them, because a bar's length is read as a quantity. A dot carries
 * no such claim, which is what lets the axis start wherever the data does.
 *
 * The cheapest day is drawn larger **and** named in the table beside the chart,
 * so the finding does not depend on noticing a size difference.
 */
export function WeekdayPriceChart({
  prices,
  cheapestWeekday,
  formatPrice,
}: Props): ReactElement {
  const { x0, x1, y0, y1 } = plotBounds(AREA);
  const yExtent = extentOf(prices.map((price) => price.averagePrice));
  const slot = prices.length === 0 ? 0 : (x1 - x0) / prices.length;

  const summary =
    prices.length === 0
      ? null
      : `${prices.length} days, from ${formatPrice(yExtent.min)} to ${formatPrice(yExtent.max)}.`;

  const rows = prices.map((price) => ({
    label: price.symbol,
    value:
      price.weekday === cheapestWeekday
        ? `${formatPrice(price.averagePrice)} — cheapest day`
        : formatPrice(price.averagePrice),
  }));

  return (
    <div className="card">
      <ChartFrame
        title="Price by day of the week"
        summary={summary}
        rows={rows}
        rowHeadings={['Day', 'Average price']}
      >
        {prices.length === 0 ? (
          <p className="empty" style={{ padding: '24px 0' }}>
            Not enough data yet.
          </p>
        ) : (
          <svg
            viewBox={`0 0 ${AREA.width} ${AREA.height}`}
            width="100%"
            focusable="false"
            aria-hidden="true"
            style={{ display: 'block', maxHeight: 190 }}
          >
            {niceTicks(yExtent, 3).map((tick) => {
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
                    {formatPrice(tick)}
                  </text>
                </g>
              );
            })}

            {prices.map((price, index) => {
              const cheapest = price.weekday === cheapestWeekday;
              const centre = x0 + slot * (index + 0.5);
              return (
                <g key={price.weekday}>
                  <circle
                    cx={centre}
                    cy={scale(price.averagePrice, yExtent, y0, y1)}
                    r={cheapest ? 6 : 4}
                    fill={cheapest ? 'var(--accent-green)' : 'var(--accent-orange)'}
                  />
                  <text
                    x={centre}
                    y={AREA.height - 6}
                    textAnchor="middle"
                    fontSize={8}
                    fill="var(--text-secondary)"
                  >
                    {price.symbol}
                  </text>
                </g>
              );
            })}
          </svg>
        )}
      </ChartFrame>
    </div>
  );
}
