import { describe, expect, test } from 'vitest';
import type { DateValuePoint } from './models';
import { chartSummary } from './chartAccessibility';

const whole = (value: number): string => value.toFixed(0);

function series(values: number[]): DateValuePoint[] {
  return values.map((value, index) => ({
    id: `p${index}`,
    date: new Date(2025, 0, 1 + index),
    value,
  }));
}

describe('chartSummary', () => {
  test('describes range, average, latest and direction', () => {
    const summary = chartSummary(series([30, 24, 36]), 'MPG', whole);
    expect(summary).toBe('3 points, from 24 to 36 MPG, averaging 30, latest 36, trending up.');
  });

  test('a single point says so rather than reciting statistics about itself', () => {
    expect(chartSummary(series([42]), 'MPG', whole)).toBe('One point, 42 MPG.');
  });

  test('an empty series has nothing to say', () => {
    expect(chartSummary([], 'MPG', whole)).toBeNull();
  });

  test('calls a small wobble flat rather than a trend', () => {
    // Announcing "trending up" for a tenth of a cent would make the word
    // useless, so there is a band around where the series started.
    expect(chartSummary(series([100, 101]), 'MPG', whole)).toContain('roughly flat');
    expect(chartSummary(series([100, 99]), 'MPG', whole)).toContain('roughly flat');
    expect(chartSummary(series([100, 103]), 'MPG', whole)).toContain('trending up');
    expect(chartSummary(series([100, 97]), 'MPG', whole)).toContain('trending down');
  });

  test('the band is relative to where the series started, not absolute', () => {
    // Two points apart by 3 read as flat at one scale and as a trend at another.
    expect(chartSummary(series([1000, 1015]), 'x', whole)).toContain('roughly flat');
    expect(chartSummary(series([10, 11]), 'x', whole)).toContain('trending up');
  });

  test('a flat series is flat, not a trend in either direction', () => {
    expect(chartSummary(series([32, 32, 32]), 'MPG', whole)).toContain('roughly flat');
  });

  test('uses the caller formatter, so summary and axis agree', () => {
    const money = (value: number): string => `$${value.toFixed(2)}`;
    expect(chartSummary(series([3, 4]), 'per gallon', money)).toContain('$3.00 to $4.00');
  });

  test('reports the true low and high, not the endpoints', () => {
    // The series dips below and rises above where it starts and ends.
    const summary = chartSummary(series([30, 12, 50, 31]), 'MPG', whole);
    expect(summary).toContain('from 12 to 50');
  });
});

describe('hostile input', () => {
  test('zero as a starting value does not make everything flat', () => {
    // A relative band around zero collapses: 0 × 1.02 is still 0, so anything
    // above it reads as a rise. That is the right answer here, and pinning it
    // means a later "improvement" cannot silently change it.
    expect(chartSummary(series([0, 5]), 'x', whole)).toContain('trending up');
    expect(chartSummary(series([0, 0]), 'x', whole)).toContain('roughly flat');
  });

  test('negative values do not invert the direction words', () => {
    // A series going from -10 to -5 has risen, and must not be described as
    // falling because the multiplication flipped.
    const summary = chartSummary(series([-10, -5]), 'x', whole);
    expect(summary).toContain('trending up');
  });

  test('does not throw on non-finite values', () => {
    expect(() => chartSummary(series([Number.NaN, 1]), 'x', whole)).not.toThrow();
    expect(() => chartSummary(series([Number.POSITIVE_INFINITY]), 'x', whole)).not.toThrow();
  });

  test('handles a very long series without blowing the stack', () => {
    // Math.min(...values) spreads every element as an argument, which throws
    // past roughly a hundred thousand.
    const long = series(Array.from({ length: 200_000 }, (_, i) => i % 50));
    expect(() => chartSummary(long, 'x', whole)).not.toThrow();
  });
});
