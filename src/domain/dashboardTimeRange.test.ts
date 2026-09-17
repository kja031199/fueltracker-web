import { describe, expect, test } from 'vitest';
import { DASHBOARD_TIME_RANGES, cutoffFrom } from './dashboardTimeRange';

const day = (year: number, month: number, dayOfMonth: number): Date =>
  new Date(year, month - 1, dayOfMonth);

const ymd = (date: Date): [number, number, number] => [
  date.getFullYear(),
  date.getMonth() + 1,
  date.getDate(),
];

describe('cutoffFrom', () => {
  test('All has no cutoff', () => {
    expect(cutoffFrom('All')).toBeNull();
    expect(cutoffFrom('All', day(2025, 6, 15))).toBeNull();
  });

  test('subtracts the right number of months', () => {
    const now = day(2025, 6, 15);
    expect(ymd(cutoffFrom('3M', now)!)).toEqual([2025, 3, 15]);
    expect(ymd(cutoffFrom('6M', now)!)).toEqual([2024, 12, 15]);
    expect(ymd(cutoffFrom('1Y', now)!)).toEqual([2024, 6, 15]);
  });

  test('shorter ranges have more recent cutoffs', () => {
    const now = day(2025, 6, 15);
    const three = cutoffFrom('3M', now)!;
    const six = cutoffFrom('6M', now)!;
    const year = cutoffFrom('1Y', now)!;
    expect(three.getTime()).toBeGreaterThan(six.getTime());
    expect(six.getTime()).toBeGreaterThan(year.getTime());
    expect(three.getTime()).toBeLessThan(now.getTime());
  });

  test('every range is covered and the list is stable', () => {
    expect(DASHBOARD_TIME_RANGES).toHaveLength(4);
    expect([...DASHBOARD_TIME_RANGES]).toEqual(['3M', '6M', '1Y', 'All']);
  });

  test('defaults its reference to now', () => {
    const cutoff = cutoffFrom('3M')!;
    expect(cutoff.getTime()).toBeLessThan(Date.now());
  });
});

describe('month arithmetic clamps rather than rolling over', () => {
  // The one place a naive port goes quietly wrong. Swift's Calendar clamps the
  // day to the target month; JavaScript's Date constructor rolls it forward, so
  // `new Date(2025, 1, 31)` becomes 3 March. A rolled-over cutoff is LATER than
  // intended, which silently drops the oldest rows from a filtered list — the
  // result looks perfectly reasonable and is simply missing data.

  test('31 May minus three months is 28 February, not 3 March', () => {
    expect(ymd(cutoffFrom('3M', day(2025, 5, 31))!)).toEqual([2025, 2, 28]);
  });

  test('29 February minus one year is 28 February, not 1 March', () => {
    expect(ymd(cutoffFrom('1Y', day(2024, 2, 29))!)).toEqual([2023, 2, 28]);
  });

  test('clamps into a leap February when the target year has one', () => {
    expect(ymd(cutoffFrom('1Y', day(2025, 2, 28))!)).toEqual([2024, 2, 28]);
    expect(ymd(cutoffFrom('3M', day(2024, 5, 31))!)).toEqual([2024, 2, 29]);
  });

  test('clamps 31 to 30 for the thirty-day months', () => {
    expect(ymd(cutoffFrom('3M', day(2025, 7, 31))!)).toEqual([2025, 4, 30]);
    expect(ymd(cutoffFrom('6M', day(2025, 12, 31))!)).toEqual([2025, 6, 30]);
  });

  test('a day that needs no clamping is left alone', () => {
    expect(ymd(cutoffFrom('3M', day(2025, 5, 15))!)).toEqual([2025, 2, 15]);
  });
});

describe('year boundaries', () => {
  test('crosses back over New Year correctly', () => {
    expect(ymd(cutoffFrom('3M', day(2025, 1, 15))!)).toEqual([2024, 10, 15]);
    expect(ymd(cutoffFrom('6M', day(2025, 2, 10))!)).toEqual([2024, 8, 10]);
    expect(ymd(cutoffFrom('1Y', day(2025, 1, 1))!)).toEqual([2024, 1, 1]);
  });

  test('keeps the time of day', () => {
    const now = new Date(2025, 5, 15, 14, 35, 7, 250);
    const cutoff = cutoffFrom('3M', now)!;
    expect([cutoff.getHours(), cutoff.getMinutes(), cutoff.getSeconds()]).toEqual([14, 35, 7]);
    expect(cutoff.getMilliseconds()).toBe(250);
  });
});
