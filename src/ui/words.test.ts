import { describe, expect, test } from 'vitest';
import { DASHBOARD_TIME_RANGES } from '../domain/dashboardTimeRange';
import { FUEL_GRADES } from '../domain/fuelGrade';
import { DISTANCE_UNITS, ECONOMY_UNITS, VOLUME_UNITS } from '../domain/units';
import {
  distanceWords,
  economyNames,
  gradeLabel,
  rangeLabel,
  volumeWords,
  weekdayName,
  weekdayNames,
} from './words';

/**
 * The words for the domain's identifiers (#94). They used to live beside the
 * identifiers in `domain/`; the labels are byte for byte what they were.
 */

describe('unit words', () => {
  test('are what the screens always said', () => {
    expect(volumeWords).toEqual({
      gallons: { name: 'Gallons', noun: 'Gallon' },
      liters: { name: 'Liters', noun: 'Liter' },
    });
    expect(distanceWords).toEqual({
      miles: { name: 'Miles', noun: 'Mile' },
      kilometers: { name: 'Kilometers', noun: 'Kilometer' },
    });
    expect(economyNames).toEqual({
      mpg: 'Miles per gallon',
      litersPer100km: 'Liters per 100 km',
      kmPerLiter: 'Kilometers per liter',
    });
  });

  test('cover every unit the domain has, and no other', () => {
    expect(Object.keys(volumeWords).sort()).toEqual([...VOLUME_UNITS].sort());
    expect(Object.keys(distanceWords).sort()).toEqual([...DISTANCE_UNITS].sort());
    expect(Object.keys(economyNames).sort()).toEqual([...ECONOMY_UNITS].sort());
  });
});

describe('labels for stored identifiers', () => {
  test('every grade has a label, the same as before', () => {
    expect(FUEL_GRADES.map(gradeLabel)).toEqual(['Regular', 'Midgrade', 'Premium', 'Diesel', 'E85', 'Other']);
  });

  test('every range has a label, and all of history reads as “All time”', () => {
    expect(DASHBOARD_TIME_RANGES.map(rangeLabel)).toEqual(['3M', '6M', '1Y', 'All time']);
  });
});

describe('weekday names', () => {
  test('come from Intl in the given locale, Sunday first', () => {
    expect(weekdayNames('en-US', 'short')).toEqual(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
    expect(weekdayNames('en-US', 'long')[3]).toBe('Wednesday');
    expect(weekdayNames('de-DE', 'long')[3]).toBe('Mittwoch');
  });

  test('one day by its Calendar number, 1 = Sunday', () => {
    expect(weekdayName(1, 'en-US', 'short')).toBe('Sun');
    expect(weekdayName(7, 'en-US', 'long')).toBe('Saturday');
    expect(weekdayName(3, 'de-DE', 'short')).toBe('Di');
  });

  test.each([0, 8, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY])('weekday %s names nothing', (weekday) => {
    expect(weekdayName(weekday, 'en-US', 'short')).toBe('');
  });

  test.each(['', 'not a locale', '!!!', 'x'.repeat(1_000)])('a locale Intl rejects (%#) falls back to English', (locale) => {
    expect(weekdayNames(locale, 'short')).toEqual(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
    expect(weekdayNames(locale, 'long')[0]).toBe('Sunday');
  });

  test('the fallback is a copy, so a caller cannot change the next one', () => {
    const names = weekdayNames('!!!', 'short');
    names[0] = 'changed';
    expect(weekdayNames('!!!', 'short')[0]).toBe('Sun');
  });
});
