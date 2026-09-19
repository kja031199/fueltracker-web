/**
 * The maths behind the charts, kept apart from the components that draw them.
 *
 * Scales, tick selection and path building are the parts that can be *wrong*
 * rather than merely ugly, so they live here as pure functions with their own
 * tests. What is left in the components is markup.
 */

export interface Extent {
  readonly min: number;
  readonly max: number;
}

/**
 * The value range to draw, padded so marks are not welded to the frame.
 *
 * Two cases need care. A **flat series** has zero extent and would divide by
 * zero, so it gets a band around its value — proportional, except at exactly
 * zero where a proportion of zero is still zero and a fixed pad is used. That
 * is the same rule the audio-graph data used upstream, for the same reason.
 *
 * `includeZero` is false for prices: gas is never $0, and a zero-based axis
 * would bury the cent-level differences that are the entire point of the
 * weekday chart.
 */
export function extentOf(values: readonly number[], includeZero = false): Extent {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return { min: 0, max: 1 };

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of finite) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (includeZero) {
    min = Math.min(min, 0);
    max = Math.max(max, 0);
  }

  if (min === max) {
    const pad = min === 0 ? 1 : Math.abs(min) * 0.1;
    return { min: min - pad, max: max + pad };
  }
  const pad = (max - min) * 0.08;
  return { min: min - pad, max: max + pad };
}

/**
 * Round numbers inside an extent, for axis labels.
 *
 * Picks a step from the 1 / 2 / 5 / 10 family so labels read as 10, 20, 30
 * rather than 13.7, 27.4 — the difference between an axis someone can use to
 * estimate a value and one they have to read character by character.
 */
export function niceTicks(extent: Extent, count = 4): number[] {
  const span = extent.max - extent.min;
  if (!Number.isFinite(span) || span <= 0) return [extent.min];

  const rough = span / Math.max(1, count);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalised = rough / magnitude;
  const step =
    magnitude * (normalised >= 5 ? 10 : normalised >= 2.5 ? 5 : normalised >= 1.5 ? 2 : 1);

  // Rounded to the step's own precision, which is the only thing that removes
  // the drift. Repeated addition accumulates it, and re-multiplying by the
  // step does not undo it: 0.3 / 0.1 rounds to 3, and 3 * 0.1 is
  // 0.30000000000000004 again, because 0.1 has no exact binary form. Fixing
  // the decimal places does.
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  const firstIndex = Math.ceil(extent.min / step);
  const ticks: number[] = [];
  for (let i = firstIndex; i * step <= extent.max + step * 1e-9; i += 1) {
    ticks.push(Number((i * step).toFixed(decimals)));
  }
  return ticks;
}

/** Maps a value in `extent` onto a pixel position between `lo` and `hi`. */
export function scale(value: number, extent: Extent, lo: number, hi: number): number {
  const span = extent.max - extent.min;
  if (span === 0) return (lo + hi) / 2;
  const t = (value - extent.min) / span;
  return lo + t * (hi - lo);
}

export interface PlotArea {
  readonly width: number;
  readonly height: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

export function plotBounds(area: PlotArea): {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
} {
  return {
    x0: area.left,
    x1: area.width - area.right,
    // SVG y grows downward, so the *top* of the plot is the *maximum* value.
    y0: area.height - area.bottom,
    y1: area.top,
  };
}

export interface PlotPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * An SVG path through the points.
 *
 * Straight segments rather than a smoothed curve. A monotone spline looks
 * nicer and invents values between the marks that were never measured, which
 * on a fuel-economy chart is a small lie.
 */
export function linePath(points: readonly PlotPoint[]): string {
  if (points.length === 0) return '';
  return points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(' ');
}
