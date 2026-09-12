import { describe, expect, test } from 'vitest';
import { DEFAULT_CURRENCY, currencyForLocale, plainCurrency } from './format';

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
