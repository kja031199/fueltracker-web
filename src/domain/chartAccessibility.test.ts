import { describe, expect, test } from 'vitest';
import type { DateValuePoint } from './models';
import { summarizeSeries } from './chartAccessibility';

/**
 * The gist of a series as values (#94). The sentence built from them is tested
 * in `ui/charts/chartSummary.test.ts`.
 */
function series(values: number[]): DateValuePoint[] {
  return values.map((value, index) => ({ id: `p${index}`, date: new Date(2025, 0, 1 + index), value }));
}

describe('summarizeSeries', () => {
  test('range, average, latest, count and direction', () => {
    expect(summarizeSeries(series([30, 24, 36]))).toEqual({
      count: 3,
      low: 24,
      high: 36,
      average: 30,
      latest: 36,
      trend: 'up',
    });
  });

  test('a single point is its own range, and flat', () => {
    expect(summarizeSeries(series([42]))).toEqual({ count: 1, low: 42, high: 42, average: 42, latest: 42, trend: 'flat' });
  });

  test('an empty series has nothing to summarise', () => {
    expect(summarizeSeries([])).toBeNull();
  });

  test('the flat band is relative to where the series started', () => {
    expect(summarizeSeries(series([100, 101]))?.trend).toBe('flat');
    expect(summarizeSeries(series([100, 97]))?.trend).toBe('down');
    expect(summarizeSeries(series([1000, 1015]))?.trend).toBe('flat');
    expect(summarizeSeries(series([10, 11]))?.trend).toBe('up');
  });

  test('negative values and a zero start keep their direction', () => {
    expect(summarizeSeries(series([-10, -5]))?.trend).toBe('up');
    expect(summarizeSeries(series([0, 5]))?.trend).toBe('up');
    expect(summarizeSeries(series([0, 0]))?.trend).toBe('flat');
  });

  test('non-finite values and a very long series do not throw', () => {
    expect(() => summarizeSeries(series([Number.NaN, 1]))).not.toThrow();
    expect(summarizeSeries(series(Array.from({ length: 200_000 }, (_, i) => i % 50)))?.high).toBe(49);
  });
});
