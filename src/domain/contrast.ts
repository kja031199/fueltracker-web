/**
 * WCAG 2.2 contrast maths, ported from the `// MARK: - WCAG math` section of
 * `Shared/Support/AccessiblePalette.swift`.
 *
 * Kept in its own module, separate from the palette that uses it, for the same
 * reason the Swift stores colours as components rather than as `Color` values:
 * the tests have to be able to measure a *candidate* colour — Apple's stock
 * orange, say — with exactly the maths the palette is held to, without
 * importing the palette's own answers. A guarantee you can only check against
 * itself isn't a guarantee.
 */

/**
 * An sRGB colour as plain components, each nominally 0–1.
 *
 * Numbers rather than a CSS string, because a string can't be measured. This is
 * the whole reason `ContrastTests` upstream can recompute every ratio on each CI
 * run instead of trusting a one-time audit, and the port keeps that property.
 */
export interface RGB {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
}

/**
 * Relative luminance, per the WCAG 2.2 definition.
 *
 * Faithful to the Swift, including the `0.03928` linearisation threshold and
 * the 0.2126 / 0.7152 / 0.0722 channel weights. Deliberately does **not** clamp
 * its input: an out-of-gamut component should measure as the nonsense it is
 * rather than be quietly corrected into something that passes.
 */
export function relativeLuminance(color: RGB): number {
  const channel = (value: number): number =>
    value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
  return (
    0.2126 * channel(color.red) + 0.7152 * channel(color.green) + 0.0722 * channel(color.blue)
  );
}

/**
 * Contrast ratio between two colours, from 1:1 (identical) to 21:1 (black on
 * white). Symmetric — order doesn't matter, so a foreground/background mix-up
 * can't hide a failure.
 */
export function contrastRatio(a: RGB, b: RGB): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

/**
 * `foreground` composited over `background` at `opacity` — ordinary source-over
 * alpha blending, done per channel in the same non-linear sRGB space the Swift
 * mixes in, so the two produce identical components.
 *
 * At opacity 0 this returns the background exactly; at 1, the foreground.
 */
export function blend(foreground: RGB, background: RGB, opacity: number): RGB {
  const mix = (f: number, b: number): number => f * opacity + b * (1 - opacity);
  return {
    red: mix(foreground.red, background.red),
    green: mix(foreground.green, background.green),
    blue: mix(foreground.blue, background.blue),
  };
}

/**
 * One 0–1 component as a 0–255 CSS channel.
 *
 * Clamps, and maps a non-finite component to 0. This has no counterpart in the
 * Swift because it has no counterpart in the problem: SwiftUI takes the
 * components directly. On the web the value becomes text in a stylesheet, and
 * an out-of-range or `NaN` channel makes the whole declaration invalid — which
 * a browser drops silently, inheriting whatever colour sits underneath. That is
 * failing *open* on the one guarantee this module exists to make, so a bad
 * component becomes visible black rather than an invisible no-op.
 */
function channel255(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.min(1, Math.max(0, value)) * 255);
}

/** The colour as a CSS `rgb()` string. */
export function toCssRgb(color: RGB): string {
  return `rgb(${channel255(color.red)} ${channel255(color.green)} ${channel255(color.blue)})`;
}
