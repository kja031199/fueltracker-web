import { describe, expect, test, vi } from 'vitest';
import { US } from './units';
import {
  DEFAULT_CURRENCY,
  volume,
  costPerDistance,
  currency,
  currencyForLocale,
  distance,
  economy,
  fuelPrice,
  numberFormat,
  plainCurrency,
  vehicleYear,
  US_STYLE,
  countOf,
  displayLocale,
  formatDate,
  isCurrencyCode,
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

describe('volume', () => {
  test('keeps up to three digits and drops trailing zeros', () => {
    // A pump reads 9.5 gallons, not 9.500 — but 12.345 keeps every digit it
    // printed, because that third one is real precision.
    expect(volume(9.5, 'gallons')).toBe('9.5');
    expect(volume(12.345, 'gallons')).toBe('12.345');
    expect(volume(10, 'gallons')).toBe('10');
  });

  test('converts to litres and can carry its unit', () => {
    expect(volume(1, 'liters')).toBe('3.785');
    expect(volume(1, 'gallons', true)).toBe('1 gal');
    expect(volume(1, 'liters', true)).toBe('3.785 L');
  });

  test('does not throw on a non-finite volume', () => {
    expect(() => volume(Number.NaN, 'gallons')).not.toThrow();
  });
});

describe('formatters are made once per shape (#88)', () => {
  test('the same locale and options give the same formatter; different ones do not', () => {
    const a = numberFormat('en-US', { maximumFractionDigits: 1 });
    expect(numberFormat('en-US', { maximumFractionDigits: 1 })).toBe(a);
    expect(numberFormat('en-US', { maximumFractionDigits: 2 })).not.toBe(a);
    expect(numberFormat('de-DE', { maximumFractionDigits: 1 })).not.toBe(a);
  });

  test('formatting a list does not build a formatter per value', () => {
    const made = vi.spyOn(Intl, 'NumberFormat');
    try {
      for (let i = 0; i < 50; i += 1) {
        volume(i + 0.123, 'gallons');
        currency(i, { locale: 'en-GB' });
      }
      // At most one each: the shapes may already be cached from other tests.
      expect(made.mock.calls.length).toBeLessThanOrEqual(2);
    } finally {
      made.mockRestore();
    }
  });

  test('an invalid currency still throws, every time — nothing is cached for it', () => {
    expect(() => currency(1, { currency: 'NOT-A-CODE' })).toThrow(RangeError);
    expect(() => currency(1, { currency: 'NOT-A-CODE' })).toThrow(RangeError);
  });

  test('many shapes stay correct past the cache’s cap', () => {
    for (let digits = 0; digits <= 20; digits += 1) {
      for (const locale of ['en-US', 'en-GB', 'de-DE', 'fr-FR']) {
        expect(numberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(1)).toBe(
          new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(1),
        );
      }
    }
  });
});

describe('vehicleYear, the year typed when adding a car (#93: moved out of Vehicles)', () => {
  const now = new Date(2026, 10, 9);

  test('a typed year is that year', () => {
    expect(vehicleYear('2021', now)).toBe(2021);
    expect(vehicleYear(' 2021 ', now)).toBe(2021);
  });

  test('blank or nonsense is this year, never NaN', () => {
    for (const text of ['', '   ', 'abc', 'NaN', 'Infinity']) {
      expect(vehicleYear(text, now), JSON.stringify(text)).toBe(2026);
    }
  });

  test('it reads the leading whole number, as it always has', () => {
    // Pinned rather than judged: the field is type="number", so a browser
    // rarely sends these, and a stricter rule would be a change of its own.
    expect(vehicleYear('2021x', now)).toBe(2021);
    expect(vehicleYear('1e3', now)).toBe(1);
    expect(vehicleYear('2021.7', now)).toBe(2021);
    expect(vehicleYear('-5', now)).toBe(-5);
    expect(vehicleYear('0', now)).toBe(0);
    expect(vehicleYear('99999', now)).toBe(99999);
  });
});

describe('one display style: the reader\u2019s locale and currency (#94)', () => {
  const GERMAN = { locale: 'de-DE', currency: 'EUR' } as const;

  test('the US style is what every function did before, byte for byte', () => {
    expect(US_STYLE).toEqual({ locale: 'en-US', currency: 'USD' });
    expect(currency(1234.56, US_STYLE)).toBe(currency(1234.56));
    expect(volume(12.3456, 'gallons', true, 'en-US')).toBe(volume(12.3456, 'gallons', true));
    expect(formatDate(new Date(2026, 4, 1).getTime())).toBe(new Date(2026, 4, 1).toLocaleDateString('en-US'));
  });

  test('money, volume, distance and economy follow the locale', () => {
    expect(currency(1234.56, GERMAN)).toBe('1.234,56\u00a0€');
    expect(fuelPrice(3.499, 'gallons', GERMAN)).toBe('3,499\u00a0€');
    expect(volume(100, 'liters', true, 'de-DE')).toBe('378,541 L');
    expect(distance(1000, 'kilometers', true, 'de-DE')).toBe('1.609,3 km');
    expect(economy(30, 'litersPer100km', 'de-DE')).toBe('7,8');
  });

  test('dates follow the same locale, so numbers and dates never disagree', () => {
    const may1 = new Date(2026, 4, 1).getTime();
    expect(formatDate(may1, 'de-DE')).toBe('1.5.2026');
    expect(formatDate(may1, 'en-GB')).toBe('01/05/2026');
  });

  test('a date that is not a number reads as it always did, rather than throwing', () => {
    expect(formatDate(Number.NaN, 'de-DE')).toBe('Invalid Date');
    expect(formatDate(Number.POSITIVE_INFINITY)).toBe('Invalid Date');
  });

  test('the browser\u2019s language is used when Intl knows it, and en-US when not', () => {
    expect(displayLocale('de-DE')).toBe('de-DE');
    expect(displayLocale('fr')).toBe('fr');
    // Well-formed tags Intl has no data for: it would quietly format in some
    // other locale, so they are refused rather than passed on.
    for (const unknown of ['xx', 'xx-XX', 'qaa']) expect(displayLocale(unknown), unknown).toBe('en-US');
    for (const hostile of ['', '!!!', 'x'.repeat(10_000), undefined, null, 42]) {
      expect(displayLocale(hostile as unknown as string), String(hostile).slice(0, 20)).toBe('en-US');
    }
  });

  test('a currency is three capital letters, and nothing else is', () => {
    for (const good of ['USD', 'EUR', 'GBP', 'JPY']) expect(isCurrencyCode(good), good).toBe(true);
    for (const bad of ['XX', 'eur', 'EURO', '<script>', '', 'E U', 'x'.repeat(10_000), 42, null]) {
      expect(isCurrencyCode(bad), String(bad).slice(0, 20)).toBe(false);
    }
  });
});

describe('countOf: a count and the word that agrees with it (#94)', () => {
  const ROWS = { one: '# row was', other: '# rows were' };

  test('one is singular, and zero and many are plural', () => {
    expect(countOf(1, ROWS)).toBe('1 row was');
    expect(countOf(0, ROWS)).toBe('0 rows were');
    expect(countOf(3, ROWS)).toBe('3 rows were');
  });

  test('the number is in the reader\u2019s locale', () => {
    expect(countOf(1234, ROWS, 'de-DE')).toBe('1.234 rows were');
    expect(countOf(1234, ROWS)).toBe('1,234 rows were');
  });

  test('the form follows English, since the words are English, whatever the locale', () => {
    // French counts 0 as singular; "0 row was" would be wrong English.
    expect(countOf(0, ROWS, 'fr-FR')).toBe('0 rows were');
    // Polish and Arabic have more categories than English has words for.
    expect(countOf(2, ROWS, 'pl-PL')).toBe('2 rows were');
    expect(countOf(2, ROWS, 'ar')).toMatch(/rows were$/);
  });

  test('a form without a placeholder is used as it is', () => {
    expect(countOf(1, { one: 'one row', other: 'several rows' })).toBe('one row');
  });

  test('odd counts never throw', () => {
    expect(countOf(Number.NaN, ROWS)).toBe('NaN rows were');
    expect(countOf(Number.POSITIVE_INFINITY, ROWS)).toBe('∞ rows were');
    expect(countOf(-1, ROWS)).toBe('-1 row was');
  });
});
