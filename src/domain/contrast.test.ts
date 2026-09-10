import { describe, expect, test } from 'vitest';
import type { RGB } from './contrast';
import { blend, contrastRatio, relativeLuminance, toCssRgb } from './contrast';

const BLACK: RGB = { red: 0, green: 0, blue: 0 };
const WHITE: RGB = { red: 1, green: 1, blue: 1 };

describe('relativeLuminance', () => {
  test('anchors at the ends of the range', () => {
    expect(relativeLuminance(BLACK)).toBe(0);
    expect(relativeLuminance(WHITE)).toBeCloseTo(1, 10);
  });

  test('weights green most and blue least, per WCAG', () => {
    const red = relativeLuminance({ red: 1, green: 0, blue: 0 });
    const green = relativeLuminance({ red: 0, green: 1, blue: 0 });
    const blue = relativeLuminance({ red: 0, green: 0, blue: 1 });
    expect(green).toBeGreaterThan(red);
    expect(red).toBeGreaterThan(blue);
    expect(red + green + blue).toBeCloseTo(1, 10);
  });

  test('switches branch at the 0.03928 linearisation threshold', () => {
    // At and below the threshold the formula divides by 12.92; above it, the
    // gamma curve takes over. Getting this boundary wrong shifts every dark
    // value slightly and quietly changes what passes.
    const grey = (v: number): RGB => ({ red: v, green: v, blue: v });
    expect(relativeLuminance(grey(0.03928))).toBeCloseTo(0.03928 / 12.92, 12);
    // The two branches meet: just past the threshold is barely brighter, not a
    // step change.
    expect(relativeLuminance(grey(0.0393))).toBeCloseTo(0.03928 / 12.92, 5);
    expect(relativeLuminance(grey(0.0393))).toBeGreaterThan(relativeLuminance(grey(0.03928)));
  });
});

describe('contrastRatio', () => {
  test('matches the WCAG reference points', () => {
    // The two anchors the formula is defined by.
    expect(contrastRatio(BLACK, WHITE)).toBeCloseTo(21, 2);
    expect(contrastRatio(WHITE, WHITE)).toBeCloseTo(1, 4);
  });

  test('is symmetric, so a foreground/background mix-up cannot hide a fail', () => {
    expect(contrastRatio(BLACK, WHITE)).toBe(contrastRatio(WHITE, BLACK));
  });

  test('never reports below 1:1', () => {
    const mid: RGB = { red: 0.5, green: 0.5, blue: 0.5 };
    expect(contrastRatio(mid, mid)).toBeCloseTo(1, 10);
    expect(contrastRatio(mid, WHITE)).toBeGreaterThanOrEqual(1);
    expect(contrastRatio(WHITE, mid)).toBeGreaterThanOrEqual(1);
  });
});

describe('blend', () => {
  test('returns the background at opacity 0 and the foreground at 1', () => {
    expect(blend(BLACK, WHITE, 0)).toEqual(WHITE);
    expect(blend(BLACK, WHITE, 1)).toEqual(BLACK);
  });

  test('mixes per channel in the same space the Swift mixes in', () => {
    const mixed = blend(BLACK, WHITE, 0.15);
    expect(mixed.red).toBeCloseTo(0.85, 12);
    expect(mixed.green).toBeCloseTo(0.85, 12);
    expect(mixed.blue).toBeCloseTo(0.85, 12);
  });

  test('a wash is always between its ink and its ground', () => {
    const ink: RGB = { red: 0.1, green: 0.4, blue: 0.5 };
    const wash = blend(ink, WHITE, 0.15);
    expect(relativeLuminance(wash)).toBeGreaterThan(relativeLuminance(ink));
    expect(relativeLuminance(wash)).toBeLessThan(relativeLuminance(WHITE));
  });
});

describe('toCssRgb', () => {
  test('round-trips the palette components back to their documented hex', () => {
    // The Swift table carries a hex comment beside each value. If rounding here
    // disagreed with it, the web app would render a colour the upstream audit
    // never measured.
    expect(toCssRgb({ red: 0.0, green: 0.3725, blue: 0.7843 })).toBe('rgb(0 95 200)'); // #005FC8
    expect(toCssRgb({ red: 1.0, green: 0.6235, blue: 0.0392 })).toBe('rgb(255 159 10)'); // #FF9F0A
    expect(toCssRgb(WHITE)).toBe('rgb(255 255 255)');
    expect(toCssRgb(BLACK)).toBe('rgb(0 0 0)');
  });

  // Hostile input: a channel that escapes 0–1 makes the whole CSS declaration
  // invalid, and a browser drops an invalid declaration silently — inheriting
  // whatever colour is underneath. That fails open on the guarantee the palette
  // exists to make, so the output is clamped to something visible instead.
  test('clamps out-of-gamut components rather than emitting invalid CSS', () => {
    expect(toCssRgb({ red: 1.4, green: -0.2, blue: 0.5 })).toBe('rgb(255 0 128)');
    expect(toCssRgb({ red: 1e9, green: -1e9, blue: 0 })).toBe('rgb(255 0 0)');
  });

  test('maps non-finite components to 0 instead of producing NaN', () => {
    expect(toCssRgb({ red: Number.NaN, green: 0.5, blue: 0 })).toBe('rgb(0 128 0)');
    expect(toCssRgb({
      red: Number.POSITIVE_INFINITY,
      green: Number.NEGATIVE_INFINITY,
      blue: Number.NaN,
    })).toBe('rgb(0 0 0)');
  });

  test('always emits three integer channels in range', () => {
    const junk: RGB[] = [
      { red: Number.NaN, green: Number.NaN, blue: Number.NaN },
      { red: -5, green: 5, blue: 0.5 },
      { red: 0.999999, green: 0.000001, blue: 0.5 },
    ];
    for (const color of junk) {
      const match = /^rgb\((\d+) (\d+) (\d+)\)$/.exec(toCssRgb(color));
      expect(match).not.toBeNull();
      for (const channel of match!.slice(1)) {
        expect(Number(channel)).toBeGreaterThanOrEqual(0);
        expect(Number(channel)).toBeLessThanOrEqual(255);
      }
    }
  });
});
