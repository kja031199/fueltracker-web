import { describe, expect, test, vi } from 'vitest';
import { METRIC, US } from './units';
import {
  DEFAULT_CURRENCY,
  volume,
  costPerDistance,
  currency,
  currencyForLocale,
  describeSince,
  displayName,
  distance,
  economy,
  fillUpFacts,
  fillUpName,
  fuelPrice,
  numberFormat,
  plainCurrency,
  vehicleSubtitle,
  vehicleYear,
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

describe('describeSince, how long ago something last happened (#93: moved from Settings)', () => {
  const now = new Date('2026-03-10T12:00:00Z').getTime();

  test('says so plainly when nothing has synced yet', () => {
    expect(describeSince(null, now)).toBe('not yet');
  });

  test('reads as just now inside a minute', () => {
    expect(describeSince(now - 5_000, now)).toBe('just now');
  });

  test('counts minutes, then hours', () => {
    expect(describeSince(now - 3 * 60_000, now)).toBe('3 minutes ago');
    expect(describeSince(now - 60_000, now)).toBe('1 minute ago');
    expect(describeSince(now - 2 * 3_600_000, now)).toBe('2 hours ago');
    expect(describeSince(now - 3_600_000, now)).toBe('1 hour ago');
  });

  test('falls back to a date once it stops being recent', () => {
    expect(describeSince(now - 3 * 24 * 3_600_000, now)).toBe(
      new Date(now - 3 * 24 * 3_600_000).toLocaleDateString(),
    );
  });

  test('does not read a clock-skewed future timestamp as a negative age', () => {
    // A device whose clock is ahead would otherwise produce "-4 minutes ago".
    expect(describeSince(now + 240_000, now)).toBe('just now');
  });

  test('the edges between seconds, minutes, hours and a date', () => {
    expect(describeSince(now - 59_000, now)).toBe('just now');
    expect(describeSince(now - 60_000, now)).toBe('1 minute ago');
    expect(describeSince(now - 59 * 60_000, now)).toBe('59 minutes ago');
    expect(describeSince(now - 23 * 3_600_000, now)).toBe('23 hours ago');
    expect(describeSince(now - 24 * 3_600_000, now)).toBe(new Date(now - 24 * 3_600_000).toLocaleDateString());
  });

  test('a time that is not a number reads as never, not as "Invalid Date"', () => {
    expect(describeSince(Number.NaN, now)).toBe('not yet');
    expect(describeSince(Number.POSITIVE_INFINITY, now)).toBe('not yet');
    expect(describeSince(Number.NEGATIVE_INFINITY, now)).toBe('not yet');
  });
});

describe('vehicleSubtitle (#93: moved from Vehicles)', () => {
  const car = { year: 2021, make: 'Honda', model: 'Civic' };

  test('year, make and model, as one line', () => {
    expect(vehicleSubtitle(car)).toBe('2021 Honda Civic');
  });

  test('a part left empty is left out, not shown as a gap', () => {
    expect(vehicleSubtitle({ ...car, make: '' })).toBe('2021 Civic');
    expect(vehicleSubtitle({ ...car, model: '' })).toBe('2021 Honda');
  });

  test('a year alone says nothing worth a line', () => {
    expect(vehicleSubtitle({ ...car, make: '', model: '' })).toBe('');
    expect(vehicleSubtitle({ year: 0, make: '', model: '' })).toBe('');
  });
});

describe('displayName, who a person is shown as (#93: four copies before)', () => {
  test('their name, when they gave one', () => {
    expect(displayName({ name: 'Sam', email: 'sam@example.com' })).toBe('Sam');
  });

  test('their email when the name is empty — or only spaces, which used to show as a blank', () => {
    expect(displayName({ name: '', email: 'sam@example.com' })).toBe('sam@example.com');
    expect(displayName({ name: '   ', email: 'sam@example.com' })).toBe('sam@example.com');
  });

  test('the fallback when there is neither', () => {
    expect(displayName({ name: '', email: '' })).toBe('someone');
    expect(displayName({ name: ' ', email: ' ' }, 'its owner')).toBe('its owner');
  });

  test('trimmed, so stray spaces never reach a sentence', () => {
    expect(displayName({ name: '  Sam ', email: '' })).toBe('Sam');
    expect(displayName({ name: '', email: ' sam@example.com ' })).toBe('sam@example.com');
  });
});

describe('fillUpFacts, the grey line under a fill-up (#93: two copies before)', () => {
  const entry = { gallons: 10, odometer: 12_345, fuelGrade: 'Regular', isFullTank: true, missedPreviousFillUp: false };

  test('volume, distance and grade, in the reader’s units', () => {
    expect(fillUpFacts(entry, US)).toEqual(['10 gal', '12,345 mi', 'Regular']);
    const metric = fillUpFacts(entry, METRIC);
    expect(metric[0]).toMatch(/^37\.854 L$/);
    expect(metric[1]).toBe('19,867.4 km');
  });

  test('a partial fill says so', () => {
    expect(fillUpFacts({ ...entry, isFullTank: false }, US)).toContain('partial fill');
  });

  test('a missed fill-up is said only where the line is about the reader’s own log', () => {
    const missed = { ...entry, missedPreviousFillUp: true };
    expect(fillUpFacts(missed, US, { missed: true })).toContain('missed previous');
    expect(fillUpFacts(missed, US)).not.toContain('missed previous');
    expect(fillUpFacts(entry, US, { missed: true })).not.toContain('missed previous');
  });

  test('zero and huge numbers are written out, never as NaN', () => {
    const facts = fillUpFacts({ ...entry, gallons: 0, odometer: 9_999_999 }, US).join(' · ');
    expect(facts).not.toMatch(/NaN|Infinity|undefined/);
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

describe('fillUpName, which fill-up a row’s buttons are for (#95)', () => {
  const entry = { date: new Date(2026, 0, 5, 9, 0).getTime(), odometer: 10_000 };

  test('its date and its odometer reading, in the reader’s units', () => {
    expect(fillUpName(entry, US)).toBe(`the fill-up of ${new Date(entry.date).toLocaleDateString()} at 10,000 mi`);
    expect(fillUpName(entry, METRIC)).toMatch(/at 16,093\.4 km$/);
  });

  test('two on the same day are still told apart', () => {
    expect(fillUpName({ ...entry, odometer: 10_250 }, US)).not.toBe(fillUpName(entry, US));
  });
});
