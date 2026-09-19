// @vitest-environment jsdom
import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { DateValuePoint } from '../../domain/models';
import type { MonthlyTotal } from '../../domain/fuelStatistics';
import type { WeekdayPrice } from '../../domain/weekdayPricePattern';
import { MetricLineChart } from './MetricLineChart';
import { MonthlyBarChart } from './MonthlyBarChart';
import { WeekdayPriceChart } from './WeekdayPriceChart';

afterEach(cleanup);

const whole = (value: number): string => value.toFixed(0);

function series(values: number[]): DateValuePoint[] {
  return values.map((value, index) => ({
    id: `p${index}`,
    date: new Date(2025, 0, 1 + index),
    value,
  }));
}

describe('a line chart', () => {
  test('describes itself in one sentence, not as a picture nobody can read', () => {
    // The iOS app pairs the summary with an audio graph; the web has no
    // equivalent, so this sentence and the table below carry the whole load.
    render(
      <MetricLineChart
        title="Fuel economy"
        points={series([30, 24, 36])}
        metric="economy"
        unit="MPG"
        formatValue={whole}
      />,
    );
    const figure = screen.getByRole('img');
    expect(figure).toHaveAttribute(
      'aria-label',
      expect.stringContaining('3 points, from 24 to 36 MPG'),
    );
    expect(figure.getAttribute('aria-label')).toContain('trending up');
  });

  test('offers every value as a real table, navigable cell by cell', () => {
    // Strictly more useful than per-mark ARIA on SVG: a table announces its
    // own row and column headers and can be read in any order.
    render(
      <MetricLineChart
        title="Fuel economy"
        points={series([30, 24])}
        metric="economy"
        unit="MPG"
        formatValue={whole}
      />,
    );
    const table = screen.getByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'MPG' })).toBeInTheDocument();
    expect(within(table).getAllByRole('row')).toHaveLength(3); // header plus two
    expect(within(table).getByText('24')).toBeInTheDocument();
  });

  test('the drawing itself is hidden from assistive technology', () => {
    // Otherwise a reader walks dozens of unlabelled path and circle nodes
    // before reaching anything meaningful.
    const { container } = render(
      <MetricLineChart
        title="Fuel economy"
        points={series([30, 24])}
        metric="economy"
        unit="MPG"
        formatValue={whole}
      />,
    );
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  test('says there is no data rather than drawing an empty frame', () => {
    render(
      <MetricLineChart
        title="Fuel economy"
        points={[]}
        metric="economy"
        unit="MPG"
        formatValue={whole}
      />,
    );
    expect(screen.getByText(/not enough data yet/i)).toBeInTheDocument();
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', 'Fuel economy: no data yet.');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  test('a single point renders without dividing by zero', () => {
    const { container } = render(
      <MetricLineChart
        title="Fuel economy"
        points={series([42])}
        metric="economy"
        unit="MPG"
        formatValue={whole}
      />,
    );
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('One point');
    const path = container.querySelector('path');
    expect(path?.getAttribute('d')).toMatch(/^M[\d.]+ [\d.]+$/);
    expect(path?.getAttribute('d')).not.toContain('NaN');
  });

  test('a flat series produces finite coordinates', () => {
    const { container } = render(
      <MetricLineChart
        title="Price"
        points={series([3.5, 3.5, 3.5])}
        metric="price"
        unit="per gal"
        formatValue={whole}
      />,
    );
    for (const element of container.querySelectorAll('path, circle, line, rect')) {
      expect(element.outerHTML).not.toContain('NaN');
    }
  });

  test('thins the drawn marks for a long history but describes all of them', () => {
    // Downsampling is display-only: the summary still counts every point, so
    // the chart and the dashboard cannot disagree about how much data there is.
    const long = series(Array.from({ length: 2_000 }, (_, i) => 30 + (i % 7)));
    const { container } = render(
      <MetricLineChart
        title="Fuel economy"
        points={long}
        metric="economy"
        unit="MPG"
        formatValue={whole}
      />,
    );
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('2000 points');
    // Well under 2,000 nodes drawn.
    expect(container.querySelectorAll('circle').length).toBeLessThan(100);
    expect(within(screen.getByRole('table')).getAllByRole('row').length).toBeLessThan(600);
  });

  test('draws the average as a rule when given one', () => {
    const { container } = render(
      <MetricLineChart
        title="Fuel economy"
        points={series([30, 40])}
        metric="economy"
        unit="MPG"
        formatValue={whole}
        average={35}
      />,
    );
    expect(container.querySelector('line[stroke-dasharray]')).toBeInTheDocument();
  });
});

describe('a monthly bar chart', () => {
  const totals: MonthlyTotal[] = [
    { month: new Date(2025, 0, 1), totalSpent: 120, totalGallons: 30, miles: 900, fillUpCount: 3 },
    { month: new Date(2025, 1, 1), totalSpent: 90, totalGallons: 24, miles: 700, fillUpCount: 2 },
  ];

  test('lists each month by name in the table', () => {
    render(
      <MonthlyBarChart
        title="Monthly spending"
        totals={totals}
        value={(total) => total.totalSpent}
        metric="spending"
        unit="spent"
        formatValue={(value) => `$${value.toFixed(0)}`}
      />,
    );
    const table = screen.getByRole('table');
    expect(within(table).getByRole('rowheader', { name: 'January 2025' })).toBeInTheDocument();
    expect(within(table).getByText('$120')).toBeInTheDocument();
  });

  test('bars start at zero, because length is read as quantity', () => {
    // A truncated bar lies about proportion — twice the height has to mean
    // twice the amount, which is the whole reason to draw a bar at all.
    const { container } = render(
      <MonthlyBarChart
        title="Monthly spending"
        totals={totals}
        value={(total) => total.totalSpent}
        metric="spending"
        unit="spent"
        formatValue={(value) => `$${value.toFixed(0)}`}
      />,
    );
    const rects = [...container.querySelectorAll('rect')];
    const heights = rects.map((r) => Number(r.getAttribute('height')));
    // 90 is three quarters of 120, so its bar must be about three quarters as
    // tall. On a truncated axis it would be far shorter than that.
    expect(heights[1]! / heights[0]!).toBeCloseTo(0.75, 1);
  });

  test('an empty set says so', () => {
    render(
      <MonthlyBarChart
        title="Monthly spending"
        totals={[]}
        value={(total) => total.totalSpent}
        metric="spending"
        unit="spent"
        formatValue={whole}
      />,
    );
    expect(screen.getByText(/not enough data yet/i)).toBeInTheDocument();
  });
});

describe('the weekday dot plot', () => {
  const prices: WeekdayPrice[] = [
    { weekday: 3, symbol: 'Tue', averagePrice: 3.2, fillUpCount: 2 },
    { weekday: 6, symbol: 'Fri', averagePrice: 3.45, fillUpCount: 2 },
  ];

  test('names the cheapest day in words, not only by dot size', () => {
    // The finding must not depend on noticing that one circle is bigger.
    render(<WeekdayPriceChart prices={prices} cheapestWeekday={3} formatPrice={(v) => `$${v.toFixed(3)}`} />);
    const table = screen.getByRole('table');
    expect(within(table).getByText(/cheapest day/i)).toBeInTheDocument();
    expect(within(table).getByRole('rowheader', { name: 'Tue' })).toBeInTheDocument();
  });

  test('the axis is zoomed, so cent-level differences are visible', () => {
    // Gas is never $0. A zero-based axis would put these two dots on top of
    // each other, which is exactly the information the chart exists to show.
    const { container } = render(
      <WeekdayPriceChart prices={prices} cheapestWeekday={3} formatPrice={(v) => `$${v.toFixed(3)}`} />,
    );
    const ys = [...container.querySelectorAll('circle')].map((c) => Number(c.getAttribute('cy')));
    expect(Math.abs(ys[0]! - ys[1]!)).toBeGreaterThan(40);
  });

  test('handles a single day without dividing by zero', () => {
    const { container } = render(
      <WeekdayPriceChart prices={[prices[0]!]} cheapestWeekday={3} formatPrice={whole} />,
    );
    for (const element of container.querySelectorAll('circle, line')) {
      expect(element.outerHTML).not.toContain('NaN');
    }
  });

  test('an empty week says so', () => {
    render(<WeekdayPriceChart prices={[]} cheapestWeekday={null} formatPrice={whole} />);
    expect(screen.getByText(/not enough data yet/i)).toBeInTheDocument();
  });
});
