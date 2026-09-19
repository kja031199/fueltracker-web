import { describe, expect, test } from 'vitest';
import { extentOf, linePath, niceTicks, plotBounds, scale } from './geometry';

describe('extentOf', () => {
  test('pads so marks are not welded to the frame', () => {
    const extent = extentOf([10, 20]);
    expect(extent.min).toBeLessThan(10);
    expect(extent.max).toBeGreaterThan(20);
  });

  test('gives a flat series a band rather than dividing by zero', () => {
    const extent = extentOf([32, 32, 32]);
    expect(extent.min).toBeLessThan(32);
    expect(extent.max).toBeGreaterThan(32);
  });

  test('a flat series at zero gets a fixed pad, since a proportion of zero is zero', () => {
    expect(extentOf([0, 0])).toEqual({ min: -1, max: 1 });
  });

  test('excludes zero by default, because gas is never free', () => {
    // A zero-based axis buries the cent-level differences that are the whole
    // point of a price chart.
    const extent = extentOf([3.2, 3.4]);
    expect(extent.min).toBeGreaterThan(3);
  });

  test('includes zero when asked, for spending bars', () => {
    const extent = extentOf([120, 140], true);
    expect(extent.min).toBeLessThanOrEqual(0);
  });

  test('ignores non-finite values rather than producing an infinite axis', () => {
    const extent = extentOf([10, Number.NaN, 20, Number.POSITIVE_INFINITY]);
    expect(Number.isFinite(extent.min)).toBe(true);
    expect(Number.isFinite(extent.max)).toBe(true);
  });

  test('an empty series still produces a drawable axis', () => {
    expect(extentOf([])).toEqual({ min: 0, max: 1 });
  });
});

describe('niceTicks', () => {
  test('picks round numbers a reader can estimate against', () => {
    // Steps come from the 1 / 2 / 5 / 10 family, so a requested count is a
    // hint rather than a promise: asking for four over 0-100 gives a step of
    // 50 and three labels, because 25 is not in the family. Coarser and
    // readable beats exact and awkward — an axis labelled 13.7, 27.4 is one
    // you read character by character instead of estimating against.
    expect(niceTicks({ min: 0, max: 100 }, 4)).toEqual([0, 50, 100]);
    expect(niceTicks({ min: 0, max: 100 }, 5)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceTicks({ min: 0, max: 10 }, 5)).toEqual([0, 2, 4, 6, 8, 10]);
  });

  test('stays inside the extent', () => {
    for (const tick of niceTicks({ min: 12, max: 87 })) {
      expect(tick).toBeGreaterThanOrEqual(12);
      expect(tick).toBeLessThanOrEqual(87);
    }
  });

  test('snaps away floating-point drift', () => {
    // Otherwise a tick lands on 0.30000000000000004, which renders as noise on
    // an axis label. Re-multiplying by the step does not fix it — 0.1 has no
    // exact binary form — so the rounding is to the step's decimal places.
    expect(niceTicks({ min: 0, max: 1 }, 10)).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]);
    for (const tick of niceTicks({ min: 3.19, max: 3.61 }, 4)) {
      expect(String(tick).length).toBeLessThan(6);
    }
  });

  test('handles a degenerate extent without looping forever', () => {
    expect(niceTicks({ min: 5, max: 5 })).toEqual([5]);
    expect(niceTicks({ min: 5, max: 4 })).toEqual([5]);
  });

  test('works on small fractional ranges, which is what fuel prices are', () => {
    const ticks = niceTicks({ min: 3.19, max: 3.61 }, 4);
    expect(ticks.length).toBeGreaterThan(1);
    expect(ticks.every((t) => t >= 3.19 && t <= 3.61)).toBe(true);
  });
});

describe('scale', () => {
  test('maps the extremes onto the ends', () => {
    expect(scale(0, { min: 0, max: 10 }, 0, 100)).toBe(0);
    expect(scale(10, { min: 0, max: 10 }, 0, 100)).toBe(100);
    expect(scale(5, { min: 0, max: 10 }, 0, 100)).toBe(50);
  });

  test('inverts happily, which is how an SVG y-axis works', () => {
    expect(scale(10, { min: 0, max: 10 }, 200, 0)).toBe(0);
    expect(scale(0, { min: 0, max: 10 }, 200, 0)).toBe(200);
  });

  test('a zero-width extent lands mid-axis rather than dividing by zero', () => {
    expect(scale(5, { min: 5, max: 5 }, 0, 100)).toBe(50);
  });
});

describe('plotBounds', () => {
  test('puts the maximum at the top, since SVG y grows downward', () => {
    const bounds = plotBounds({ width: 300, height: 200, left: 40, right: 10, top: 8, bottom: 24 });
    expect(bounds.x0).toBe(40);
    expect(bounds.x1).toBe(290);
    expect(bounds.y0).toBe(176); // baseline
    expect(bounds.y1).toBe(8); // top
    expect(bounds.y1).toBeLessThan(bounds.y0);
  });
});

describe('linePath', () => {
  test('moves to the first point and lines to the rest', () => {
    expect(linePath([{ x: 0, y: 10 }, { x: 5, y: 20 }])).toBe('M0.00 10.00 L5.00 20.00');
  });

  test('an empty series draws nothing rather than an invalid path', () => {
    expect(linePath([])).toBe('');
  });

  test('a single point is a valid move with no line', () => {
    expect(linePath([{ x: 1, y: 2 }])).toBe('M1.00 2.00');
  });
});
