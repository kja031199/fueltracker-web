import { describe, expect, test } from 'vitest';
import type { AccentHue, ColorScheme } from './accessiblePalette';
import {
  ACCENT_HUES,
  COLOR_SCHEMES,
  MINIMUM_TEXT_CONTRAST,
  TINT_OPACITY,
  cardBackground,
  color,
  components,
  groupedBackground,
  paletteCssVariables,
  tintedBackground,
} from './accessiblePalette';
import type { RGB } from './contrast';
import { blend, contrastRatio, relativeLuminance, toCssRgb } from './contrast';
import { METRICS, accessibilityName, hueFor } from './metric';

/**
 * WCAG 2.2 AA for body text. The palette targets a higher internal margin; this
 * is the standard itself, which is what actually matters.
 */
const REQUIREMENT = 4.5;

/** The three surfaces a hue can land on, in a given scheme. */
function surfaces(hue: AccentHue, scheme: ColorScheme): [string, RGB][] {
  return [
    ['card', cardBackground(scheme)],
    ['grouped', groupedBackground(scheme)],
    ['tint wash', tintedBackground(hue, scheme)],
  ];
}

describe.each(ACCENT_HUES)('%s', (hue) => {
  test.each(COLOR_SCHEMES)('is readable on every surface it lands on in %s mode', (scheme) => {
    // Includes the capsule case: the hue's own 15% wash sits behind the hue as
    // text, which is the tightest pairing in the app.
    for (const [surface, background] of surfaces(hue, scheme)) {
      const ratio = contrastRatio(components(hue, scheme), background);
      expect(
        ratio,
        `${hue} on ${surface} in ${scheme} mode is ${ratio}:1, below ${REQUIREMENT}:1`,
      ).toBeGreaterThanOrEqual(REQUIREMENT);
    }
  });

  /**
   * The margin the palette *advertises*, enforced.
   *
   * Upstream, the only test naming `minimumTextContrast` asserted that the
   * constant sat above 4.5 — it never compared a colour to it, so the number was
   * documentation rather than a guarantee and the values drifted into the gap
   * between the two. They did. A threshold constant needs a test that measures
   * real values against it.
   */
  test.each(COLOR_SCHEMES)('clears the palette own internal margin in %s mode', (scheme) => {
    for (const [surface, background] of surfaces(hue, scheme)) {
      const ratio = contrastRatio(components(hue, scheme), background);
      expect(
        ratio,
        `${hue} on ${surface} in ${scheme} is ${ratio}:1, under the palette's own ${MINIMUM_TEXT_CONTRAST}:1`,
      ).toBeGreaterThanOrEqual(MINIMUM_TEXT_CONTRAST);
    }
  });

  /**
   * Pins the recursion that makes the wash the binding constraint: it is mixed
   * from the palette's **own** value for the hue, not from a stock colour.
   * Deriving replacement values against a stock-mixed wash optimises a looser
   * constraint than the app renders and lands short of the bar — that shipped
   * once upstream and only CI caught it.
   */
  test.each(COLOR_SCHEMES)('mixes its tint wash from the palette itself in %s mode', (scheme) => {
    const ink = components(hue, scheme);
    const card = cardBackground(scheme);
    const mix = (f: number, b: number): number => f * TINT_OPACITY + b * (1 - TINT_OPACITY);

    expect(tintedBackground(hue, scheme)).toEqual({
      red: mix(ink.red, card.red),
      green: mix(ink.green, card.green),
      blue: mix(ink.blue, card.blue),
    });
  });

  /**
   * The wash is the tightest of the three surfaces, everywhere. This is the
   * structural reason the palette is derived against it: clearing the card says
   * nothing about clearing the capsule.
   */
  test.each(COLOR_SCHEMES)('has the tint wash as its binding constraint in %s mode', (scheme) => {
    const ink = components(hue, scheme);
    const wash = contrastRatio(ink, tintedBackground(hue, scheme));
    const card = contrastRatio(ink, cardBackground(scheme));
    const grouped = contrastRatio(ink, groupedBackground(scheme));

    expect(wash, `${hue}/${scheme}: wash ${wash} is not tighter than card ${card}`)
      .toBeLessThanOrEqual(card);
    expect(wash, `${hue}/${scheme}: wash ${wash} is not tighter than grouped ${grouped}`)
      .toBeLessThanOrEqual(grouped);
  });

  test.each(COLOR_SCHEMES)('stays distinguishable from its own wash in %s mode', (scheme) => {
    const ink = relativeLuminance(components(hue, scheme));
    const wash = relativeLuminance(tintedBackground(hue, scheme));
    expect(ink, `${hue} in ${scheme} has no separation from its wash`).not.toBe(wash);
  });
});

describe('the palette as a whole', () => {
  test('reproduces the measured worst case rather than merely clearing the bar', () => {
    // Upstream's audit records 4.80:1 on light-mode teal against its own wash as
    // the tightest pairing anywhere in the palette. If the port's maths drifted,
    // this is where it would show first.
    const ratios = COLOR_SCHEMES.flatMap((scheme) =>
      ACCENT_HUES.flatMap((hue) =>
        surfaces(hue, scheme).map(([, background]) =>
          contrastRatio(components(hue, scheme), background),
        ),
      ),
    );
    expect(Math.min(...ratios)).toBeCloseTo(4.8031, 3);
  });

  test('the internal margin sits above the standard', () => {
    expect(MINIMUM_TEXT_CONTRAST).toBeGreaterThanOrEqual(REQUIREMENT);
  });

  test('no two hues resolve to the same colour in either scheme', () => {
    for (const scheme of COLOR_SCHEMES) {
      const resolved = ACCENT_HUES.map((hue) => color(hue, scheme));
      expect(new Set(resolved).size).toBe(ACCENT_HUES.length);
    }
  });

  /**
   * Documents *why* the palette exists: the stock light-mode values fail the
   * same check this suite enforces. If a future refactor is tempted to
   * "simplify" back to a named colour, this is the reason not to.
   */
  test('stock light-mode orange and teal would fail the same check', () => {
    const white: RGB = { red: 1, green: 1, blue: 1 };
    const stockOrange: RGB = { red: 1.0, green: 0.5843, blue: 0.0 }; // #FF9500
    const stockTeal: RGB = { red: 0.1882, green: 0.6902, blue: 0.7804 }; // #30B0C7

    expect(contrastRatio(stockOrange, white)).toBeLessThan(REQUIREMENT);
    expect(contrastRatio(stockTeal, white)).toBeLessThan(REQUIREMENT);
    // And they fail the looser 3:1 that WCAG 1.4.11 sets for chart marks, so the
    // lines and bars themselves were non-compliant, not just the labels.
    expect(contrastRatio(stockOrange, white)).toBeLessThan(3);
    expect(contrastRatio(stockTeal, white)).toBeLessThan(3);
  });

  test('a stock-mixed wash flatters a candidate that the real wash rejects', () => {
    // The trap, made concrete. Score light-mode teal against a wash mixed from
    // the *stock* colour and it reads 5.20; against the wash the app actually
    // renders — mixed from the candidate itself — it is 4.80 and only just
    // clears the bar. That ~0.4 is exactly the margin the upstream mistake
    // spent before CI caught it.
    const card = cardBackground('light');
    const candidate = components('teal', 'light');
    const stockTeal: RGB = { red: 0.1882, green: 0.6902, blue: 0.7804 };

    const looser = contrastRatio(candidate, blend(stockTeal, card, TINT_OPACITY));
    const real = contrastRatio(candidate, tintedBackground('teal', 'light'));

    expect(looser - real).toBeCloseTo(0.394, 2);
    expect(real).toBeGreaterThanOrEqual(MINIMUM_TEXT_CONTRAST);
  });
});

describe('paletteCssVariables', () => {
  test.each(COLOR_SCHEMES)('emits an ink and a wash for every hue in %s mode', (scheme) => {
    const variables = paletteCssVariables(scheme);
    for (const hue of ACCENT_HUES) {
      expect(variables[`--accent-${hue}`]).toBe(color(hue, scheme));
      expect(variables[`--accent-${hue}-wash`]).toBe(toCssRgb(tintedBackground(hue, scheme)));
    }
    expect(variables['--surface-card']).toBe(toCssRgb(cardBackground(scheme)));
    expect(variables['--surface-grouped']).toBe(toCssRgb(groupedBackground(scheme)));
    expect(Object.keys(variables)).toHaveLength(ACCENT_HUES.length * 2 + 2);
  });

  test('every emitted value is a valid CSS colour', () => {
    for (const scheme of COLOR_SCHEMES) {
      for (const value of Object.values(paletteCssVariables(scheme))) {
        expect(value).toMatch(/^rgb\(\d{1,3} \d{1,3} \d{1,3}\)$/);
      }
    }
  });

  test('the two schemes differ, so a theme switch actually changes something', () => {
    expect(paletteCssVariables('light')).not.toEqual(paletteCssVariables('dark'));
  });
});

describe('metric', () => {
  test('every metric maps to a distinct hue and a spoken name', () => {
    // The hue mapping is what carries "blue means fuel economy" across screens;
    // the name is what a screen reader announces for a chart with no title.
    const hues = METRICS.map(hueFor);
    expect(new Set(hues).size).toBe(METRICS.length);
    expect(hues).toEqual(['blue', 'orange', 'purple', 'teal']);

    const names = METRICS.map(accessibilityName);
    expect(new Set(names).size).toBe(METRICS.length);
    expect(names.every((name) => name.length > 0)).toBe(true);
  });

  /**
   * Guards the indirection itself. Upstream this compares two opaque `Color`
   * values; here it checks that a metric's colour is one the palette produced,
   * so a hard-coded hex sneaking into a component would stop matching.
   */
  test('metric colours resolve through the accessible palette', () => {
    for (const scheme of COLOR_SCHEMES) {
      const palette = new Set(ACCENT_HUES.map((hue) => color(hue, scheme)));
      for (const metric of METRICS) {
        expect(palette.has(color(hueFor(metric), scheme))).toBe(true);
      }
      expect(color(hueFor('price'), scheme)).toBe(color('orange', scheme));
      expect(color(hueFor('economy'), scheme)).toBe(color('blue', scheme));
    }
  });

  test('every metric inherits the palette contrast guarantee', () => {
    // The point of the hue indirection: a metric cannot pick a colour the
    // contrast tests above have not already measured.
    for (const scheme of COLOR_SCHEMES) {
      for (const metric of METRICS) {
        const hue = hueFor(metric);
        for (const [, background] of surfaces(hue, scheme)) {
          expect(contrastRatio(components(hue, scheme), background))
            .toBeGreaterThanOrEqual(REQUIREMENT);
        }
      }
    }
  });
});
