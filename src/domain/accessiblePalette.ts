/**
 * Accent colours that meet **WCAG 2.2 AA** as text (4.5:1) on the backgrounds
 * this app actually draws them on, in both light and dark mode.
 *
 * Ported from `Shared/Support/AccessiblePalette.swift`. The component tables are
 * carried across verbatim: they are known-good values, derived against the
 * self-referential constraint described below and enforced by CI upstream.
 * Changing a number here is changing the accessibility guarantee.
 *
 * ## Why not just use the browser's named colours
 *
 * The same reason the iOS app doesn't use `.orange`. Apple's standard palette —
 * and every stock palette like it — is tuned to look right, not to pass a
 * contrast threshold, and its light-mode values are bright. Measured against
 * the app's own card background before this existed:
 *
 * | hue    | light  | dark   |
 * |--------|--------|--------|
 * | orange | 2.20:1 | 8.28:1 |
 * | teal   | 2.57:1 | 8.55:1 |
 * | green  | 2.22:1 | 8.42:1 |
 * | blue   | 4.02:1 | 4.66:1 |
 * | purple | 4.13:1 | 4.83:1 |
 *
 * Every one fails 4.5:1 in light mode; orange, teal and green fail even the
 * looser 3:1 that WCAG 1.4.11 sets for chart marks and other non-text graphics,
 * so the lines and bars themselves were non-compliant, not just the labels.
 *
 * The light values here are darkened versions of Apple's, and the dark values
 * are Apple's own except blue and purple, which were brightened. Hue and
 * saturation are preserved and only brightness moves, so "blue means fuel
 * economy" still reads across screens.
 *
 * ## The tint wash is self-referential — mind this when re-deriving values
 *
 * The tightest pairing in the app is a hue as text on a 15% wash **of itself**
 * (see {@link tintedBackground}). That wash is composited from *this table's*
 * value, not from a stock colour, so darkening the ink darkens its own
 * background too and the pair moves together. Contrast therefore climbs far
 * more slowly against the wash than against the card, and the wash is always
 * the binding constraint.
 *
 * Deriving a candidate against a wash mixed from a stock colour solves the
 * wrong problem: it looks like it clears the bar and lands ~0.35 short. That
 * mistake shipped once upstream and only CI caught it.
 *
 * ## The guarantee
 *
 * Each colour clears {@link MINIMUM_TEXT_CONTRAST} against all three surfaces
 * it can land on: the card background, the grouped background, and its own 15%
 * tint wash. Every value is at **4.80:1 or better**. `accessiblePalette.test.ts`
 * recomputes all of it from the components below — against both the 4.5
 * standard and this internal margin — so a palette edit that breaks the promise
 * fails the build.
 */

import type { RGB } from './contrast';
import { blend, toCssRgb } from './contrast';

/**
 * The app's accent hues.
 *
 * Named here rather than taken from a stock palette so their contrast can be
 * *guaranteed* rather than assumed.
 */
export type AccentHue = 'blue' | 'orange' | 'purple' | 'teal' | 'green';

/** Every hue, for tests and for emitting the full set of CSS variables. */
export const ACCENT_HUES = ['blue', 'orange', 'purple', 'teal', 'green'] as const;

/** The two appearances. The web analogue of SwiftUI's `ColorScheme`. */
export type ColorScheme = 'light' | 'dark';

export const COLOR_SCHEMES = ['light', 'dark'] as const;

/** Opacity of the tint wash behind capsule/banner labels. */
export const TINT_OPACITY = 0.15;

/**
 * The minimum ratio the palette is held to. WCAG 2.2 AA requires 4.5:1 for body
 * text; the extra is headroom so a small future tweak doesn't silently land a
 * hair under.
 *
 * A constant that documents a bar isn't a bar until something compares a value
 * to it — upstream this number was decorative for a while, and the values drifted
 * into the gap. `theWholePaletteClearsItsOwnInternalMargin` is what makes it real.
 */
export const MINIMUM_TEXT_CONTRAST = 4.7;

const LIGHT: Record<AccentHue, RGB> = {
  blue: { red: 0.0, green: 0.3725, blue: 0.7843 }, // #005FC8
  orange: { red: 0.5725, green: 0.3333, blue: 0.0 }, // #925500
  purple: { red: 0.549, green: 0.2549, blue: 0.6941 }, // #8C41B1
  teal: { red: 0.1176, green: 0.4275, blue: 0.4824 }, // #1E6D7B
  green: { red: 0.1176, green: 0.4471, blue: 0.2 }, // #1E7233
};

const DARK: Record<AccentHue, RGB> = {
  blue: { red: 0.2314, green: 0.6157, blue: 1.0 }, // #3B9DFF
  orange: { red: 1.0, green: 0.6235, blue: 0.0392 }, // #FF9F0A
  purple: { red: 0.8118, green: 0.4431, blue: 1.0 }, // #CF71FF
  teal: { red: 0.251, green: 0.7843, blue: 0.8784 }, // #40C8E0
  green: { red: 0.1882, green: 0.8196, blue: 0.3451 }, // #30D158
};

/** The hue's components in the given scheme. */
export function components(hue: AccentHue, scheme: ColorScheme): RGB {
  return scheme === 'dark' ? DARK[hue] : LIGHT[hue];
}

/** The hue as a CSS colour string. */
export function color(hue: AccentHue, scheme: ColorScheme): string {
  return toCssRgb(components(hue, scheme));
}

/**
 * The card surface most labels sit on — the analogue of iOS's
 * `secondarySystemGroupedBackground`.
 */
export function cardBackground(scheme: ColorScheme): RGB {
  return scheme === 'dark'
    ? { red: 0.1098, green: 0.1098, blue: 0.1176 } // #1C1C1E
    : { red: 1, green: 1, blue: 1 }; // #FFFFFF
}

/** The page behind the cards — iOS's `systemGroupedBackground`. */
export function groupedBackground(scheme: ColorScheme): RGB {
  return scheme === 'dark'
    ? { red: 0, green: 0, blue: 0 } // #000000
    : { red: 0.949, green: 0.949, blue: 0.9686 }; // #F2F2F7
}

/**
 * The tint wash actually rendered behind a capsule: the hue at
 * {@link TINT_OPACITY} composited over the card background.
 *
 * Note the recursion — the wash is mixed from the palette's *own* value for
 * `hue`, which is why it is the binding constraint on the tables above.
 */
export function tintedBackground(hue: AccentHue, scheme: ColorScheme): RGB {
  return blend(components(hue, scheme), cardBackground(scheme), TINT_OPACITY);
}

/**
 * The whole palette for one scheme as CSS custom properties.
 *
 * Components consume tokens rather than calling these functions, so a colour
 * lands in the stylesheet once per scheme instead of being recomputed per
 * render — and so a stray hard-coded hex in a component is visibly out of
 * place next to `var(--accent-blue)`.
 */
export function paletteCssVariables(scheme: ColorScheme): Record<string, string> {
  const variables: Record<string, string> = {
    '--surface-card': toCssRgb(cardBackground(scheme)),
    '--surface-grouped': toCssRgb(groupedBackground(scheme)),
  };
  for (const hue of ACCENT_HUES) {
    variables[`--accent-${hue}`] = color(hue, scheme);
    variables[`--accent-${hue}-wash`] = toCssRgb(tintedBackground(hue, scheme));
  }
  return variables;
}
