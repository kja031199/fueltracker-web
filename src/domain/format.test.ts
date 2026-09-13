import { describe, expect, test } from 'vitest';
import {
  DEFAULT_CURRENCY,
  costPerDistance,
  currency,
  currencyForLocale,
  distance,
  economy,
  fuelPrice,
  plainCurrency,
} from './format';

describe('currencyForLocale', () => {
  test('resolves the common regions', () => {
    expect(currencyForLocale('en-US')).toBe('USD');
    expect(currencyForLocale('en-GB')).toBe('GBP');
    expect(currencyForLocale('de-DE')).toBe('EUR');
    expect(currencyForLocale('ja-JP')).toBe('JPY');
  });

  test('reads the underscore form Swift writes', () => {
    // `Locale.current.identifier` is "en_US" on Apple platforms, so an exported
    // preference could arrive in that shape.
    expect(currencyForLocale('en_GB')).toBe('GBP');
  });

  test('falls back to the default for an unknown or region-less tag', () => {
    expect(currencyForLocale('en')).toBe(DEFAULT_CURRENCY);
    expect(currencyForLocale('xx-ZZ')).toBe(DEFAULT_CURRENCY);
    expect(currencyForLocale('')).toBe(DEFAULT_CURRENCY);
    expect(currencyForLocale('!!! not a tag')).toBe(DEFAULT_CURRENCY);
  });
});

describe('plainCurrency', () => {
  test('renders exactly two fraction digits', () => {
    expect(plainCurrency(0.11)).toBe('$0.11');
    expect(plainCurrency(3.2)).toBe('$3.20');
    expect(plainCurrency(0)).toBe('$0.00');
  });

  test('pins two digits even where the locale would use none', () => {
    // Intl renders JPY with no decimals by default. The Swift pins
    // `.fractionLength(2)`, and it matters: a sub-cent spread would round away
    // to nothing and the weekday insight would claim a saving of zero.
    expect(plainCurrency(1234.5, { locale: 'ja-JP' })).toContain('.50');
  });

  test('honours an explicit currency over the locale', () => {
    expect(plainCurrency(5, { locale: 'en-US', currency: 'EUR' })).toContain('5.00');
    expect(plainCurrency(5, { locale: 'en-US', currency: 'EUR' })).not.toContain('$');
  });

  test('rounds half-cents rather than truncating', () => {
    expect(plainCurrency(0.005)).toBe('$0.01');
    expect(plainCurrency(3.204)).toBe('$3.20');
    expect(plainCurrency(3.206)).toBe('$3.21');
  });

  test('handles negative values', () => {
    expect(plainCurrency(-1.5)).toBe('-$1.50');
  });

  // Hostile input. Every domain caller guards before formatting, so a
  // non-finite value here means a new caller skipped its guard — a visible
  // oddity beats a plausible-looking zero.
  test('does not disguise a non-finite value as a real amount', () => {
    expect(plainCurrency(Number.NaN)).not.toMatch(/0\.00/);
    expect(plainCurrency(Number.POSITIVE_INFINITY)).not.toMatch(/0\.00/);
  });

  test('formats a very large amount without throwing', () => {
    expect(() => plainCurrency(1e21)).not.toThrow();
    expect(plainCurrency(1e9)).toContain('1,000,000,000');
  });
});

describe('currency', () => {
  test('uses the locale own precision, unlike plainCurrency', () => {
    expect(currency(3.5)).toBe('$3.50');
    // JPY has no minor unit, and `currency` — unlike `plainCurrency` — respects
    // that. The showdown's "Total Spent" row wants the natural rendering.
    expect(currency(1234, { locale: 'ja-JP' })).not.toContain('.');
    expect(plainCurrency(1234, { locale: 'ja-JP' })).toContain('.');
  });
});

describe('economy', () => {
  test('renders exactly one fraction digit', () => {
    expect(economy(40, 'mpg')).toBe('40.0');
    expect(economy(25.44, 'mpg')).toBe('25.4');
  });

  test('converts rather than relabelling', () => {
    // L/100km is the reciprocal, so a better vehicle reads LOWER. Relabelling
    // the axis instead of converting the value is the classic way to get this
    // exactly backwards.
    const better = Number(economy(40, 'litersPer100km'));
    const worse = Number(economy(20, 'litersPer100km'));
    expect(better).toBeLessThan(worse);
    expect(Number(economy(40, 'kmPerLiter'))).toBeGreaterThan(Number(economy(20, 'kmPerLiter')));
  });

  test('returns null where economy is undefined', () => {
    // Not a placeholder string: the caller has to be able to tell "no data"
    // apart from a formatted zero, which is how a showdown row stays
    // uncontested instead of being won by a phantom value.
    for (const unit of ['mpg', 'litersPer100km', 'kmPerLiter'] as const) {
      expect(economy(0, unit)).toBeNull();
      expect(economy(-5, unit)).toBeNull();
      expect(economy(Number.NaN, unit)).toBeNull();
      expect(economy(Number.POSITIVE_INFINITY, unit)).toBeNull();
    }
  });
});

describe('fuelPrice', () => {
  test('keeps the tenth-of-a-cent digit pumps actually print', () => {
    expect(fuelPrice(3.499, 'gallons')).toBe('$3.499');
    // Rounding that digit away would make two different prices render
    // identically — which the showdown then has to call a tie.
    expect(fuelPrice(3.0001, 'gallons')).toBe('$3.000');
    expect(fuelPrice(3.0003, 'gallons')).toBe('$3.000');
  });

  test('divides by the unit, so a litre price is lower than a gallon price', () => {
    expect(Number(fuelPrice(3.785411784, 'liters').replace('$', ''))).toBeCloseTo(1.0, 3);
  });
});

describe('costPerDistance', () => {
  test('renders between two and three fraction digits', () => {
    expect(costPerDistance(0.12, 'miles')).toBe('$0.12');
    expect(costPerDistance(0.1234, 'miles')).toBe('$0.123');
  });

  test('a per-kilometer cost is lower than the same per-mile cost', () => {
    const perMile = Number(costPerDistance(0.16, 'miles').replace('$', ''));
    const perKm = Number(costPerDistance(0.16, 'kilometers').replace('$', ''));
    expect(perKm).toBeLessThan(perMile);
    expect(perKm).toBeCloseTo(0.16 / 1.609344, 3);
  });
});

describe('distance', () => {
  test('renders up to one fraction digit and drops a trailing zero', () => {
    expect(distance(1000, 'miles')).toBe('1,000');
    expect(distance(1000.25, 'miles')).toBe('1,000.3');
  });

  test('converts to kilometers and can carry its unit', () => {
    expect(distance(100, 'kilometers')).toBe('160.9');
    expect(distance(100, 'miles', true)).toBe('100 mi');
    expect(distance(100, 'kilometers', true)).toBe('160.9 km');
  });

  test('does not throw on a non-finite distance', () => {
    expect(() => distance(Number.NaN, 'miles')).not.toThrow();
    expect(() => distance(Number.POSITIVE_INFINITY, 'kilometers')).not.toThrow();
  });
});
