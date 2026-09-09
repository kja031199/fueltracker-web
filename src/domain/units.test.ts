import { describe, expect, test } from 'vitest';
import {
  DISTANCE_UNITS,
  ECONOMY_UNITS,
  KILOMETERS_PER_MILE,
  LITERS_PER_GALLON,
  METRIC,
  US,
  VOLUME_UNITS,
  distance,
  economy,
  unitPreferencesForLocale,
  volume,
} from './units';

/** Mirrors the Swift suite's tolerance helper. */
const close = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

describe('volume', () => {
  test('converts gallons and liters exactly', () => {
    expect(volume.gallons.fromGallons(10)).toBe(10);
    expect(close(volume.liters.fromGallons(1), 3.785411784)).toBe(true);
    // Round-trips back to canonical gallons.
    expect(close(volume.liters.toGallons(volume.liters.fromGallons(12.5)), 12.5)).toBe(true);
    expect(volume.gallons.abbreviation).toBe('gal');
    expect(volume.liters.abbreviation).toBe('L');
  });

  test('scales negative and zero linearly', () => {
    expect(volume.liters.fromGallons(0)).toBe(0);
    expect(close(volume.liters.fromGallons(-5), -5 * 3.785411784)).toBe(true);
  });

  test('round-trips every unit at a range of magnitudes', () => {
    for (const unit of VOLUME_UNITS) {
      for (const v of [0, 0.001, 1, 12.5, 999999]) {
        expect(close(volume[unit].toGallons(volume[unit].fromGallons(v)), v)).toBe(true);
      }
    }
  });
});

describe('distance', () => {
  test('converts miles and kilometers exactly', () => {
    expect(distance.miles.fromMiles(100)).toBe(100);
    expect(close(distance.kilometers.fromMiles(1), 1.609344)).toBe(true);
    expect(close(distance.kilometers.toMiles(distance.kilometers.fromMiles(42.2)), 42.2)).toBe(true);
    expect(distance.miles.abbreviation).toBe('mi');
    expect(distance.kilometers.abbreviation).toBe('km');
  });

  test('round-trips every unit at a range of magnitudes', () => {
    for (const unit of DISTANCE_UNITS) {
      for (const v of [0, 0.1, 42.2, 42150, 999999]) {
        expect(close(distance[unit].toMiles(distance[unit].fromMiles(v)), v)).toBe(true);
      }
    }
  });
});

describe('economy — the non-linear one', () => {
  test('converts from MPG', () => {
    expect(economy.mpg.fromMPG(30)).toBe(30);
    // 30 US MPG ≈ 12.754 km/L and ≈ 7.840 L/100km (the reciprocal).
    expect(close(economy.kmPerLiter.fromMPG(30)!, (30 * 1.609344) / 3.785411784)).toBe(true);
    expect(close(economy.litersPer100km.fromMPG(30)!, (100 * 3.785411784) / (30 * 1.609344))).toBe(
      true,
    );
  });

  test('is undefined for non-positive or non-finite input', () => {
    for (const unit of ECONOMY_UNITS) {
      expect(economy[unit].fromMPG(0)).toBeNull();
      expect(economy[unit].fromMPG(-5)).toBeNull();
      expect(economy[unit].fromMPG(Number.NaN)).toBeNull();
      expect(economy[unit].fromMPG(Number.POSITIVE_INFINITY)).toBeNull();
      // Not in the Swift suite, but -∞ must be rejected for the same reason.
      expect(economy[unit].fromMPG(Number.NEGATIVE_INFINITY)).toBeNull();
    }
  });

  test('higherIsBetter flips only for L/100km', () => {
    expect(economy.mpg.higherIsBetter).toBe(true);
    expect(economy.kmPerLiter.higherIsBetter).toBe(true);
    expect(economy.litersPer100km.higherIsBetter).toBe(false);
  });

  test('ordering is preserved by linear units and inverted by L/100km', () => {
    // A better car (higher MPG) reads higher in km/L but LOWER in L/100km.
    const worse = 20;
    const better = 40;
    expect(economy.kmPerLiter.fromMPG(better)!).toBeGreaterThan(economy.kmPerLiter.fromMPG(worse)!);
    expect(economy.litersPer100km.fromMPG(better)!).toBeLessThan(
      economy.litersPer100km.fromMPG(worse)!,
    );
  });

  test('L/100km is a true reciprocal — halving MPG doubles it', () => {
    const a = economy.litersPer100km.fromMPG(20)!;
    const b = economy.litersPer100km.fromMPG(40)!;
    expect(close(a, b * 2)).toBe(true);
  });
});

describe('preferences seed', () => {
  test('locale seeds metric or US', () => {
    expect(unitPreferencesForLocale('en-US')).toEqual(US);
    expect(unitPreferencesForLocale('fr-FR')).toEqual(METRIC);
  });

  test('accepts Swift-style underscore separators', () => {
    expect(unitPreferencesForLocale('en_US')).toEqual(US);
    expect(unitPreferencesForLocale('fr_FR')).toEqual(METRIC);
  });

  test('falls back to metric for a locale with no resolvable region', () => {
    expect(unitPreferencesForLocale('en')).toEqual(METRIC);
    expect(unitPreferencesForLocale('')).toEqual(METRIC);
    expect(unitPreferencesForLocale('!!not a locale!!')).toEqual(METRIC);
  });

  test('canonical storage units are the US preset', () => {
    // Guards the invariant that canonical == US, which the whole
    // "convert only at the boundary" design rests on.
    expect(US).toEqual({ volume: 'gallons', distance: 'miles', economy: 'mpg' });
  });
});

describe('constants', () => {
  test('conversion factors are the exact defined values', () => {
    expect(LITERS_PER_GALLON).toBe(3.785411784);
    expect(KILOMETERS_PER_MILE).toBe(1.609344);
  });
});
