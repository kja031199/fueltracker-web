import { describe, expect, test } from 'vitest';
import { GAP_FACTOR, MIN_GAPS, unusualOdometerJump } from './odometerGap';

/**
 * "Did somebody forget to log a fill-up?" (#66). Two people logging one car is
 * exactly how a fill-up goes missing, and a missing one silently stretches the
 * next MPG segment over two tanks. The rule warns; it never blocks.
 */

const EVERY_300 = [10_000, 10_300, 10_600, 10_900];

describe('flags a jump well past the usual', () => {
  test('more than twice the usual distance between fill-ups', () => {
    expect(unusualOdometerJump(11_550, EVERY_300)).toEqual({ distance: 650, usual: 300, previous: 10_900 });
  });

  test('exactly twice is not unusual — strictly more is', () => {
    expect(unusualOdometerJump(11_500, EVERY_300)).toBeNull();
    expect(unusualOdometerJump(11_500.1, EVERY_300)).not.toBeNull();
  });

  test('a normal fill-up is not', () => {
    expect(unusualOdometerJump(11_210, EVERY_300)).toBeNull();
  });

  test('the usual is the median, so one earlier missed fill-up does not hide the next', () => {
    // A 900-mile gap already in the history would drag a mean up to 450.
    const history = [10_000, 10_300, 11_200, 11_500, 11_800];
    expect(unusualOdometerJump(12_450, history)?.usual).toBe(300);
  });

  test('history in any order, and repeated readings, are handled', () => {
    expect(unusualOdometerJump(11_550, [10_900, 10_000, 10_600, 10_300, 10_300])).toEqual({
      distance: 650,
      usual: 300,
      previous: 10_900,
    });
  });

  test('an edit in the middle of the history is measured from the reading before it', () => {
    expect(unusualOdometerJump(10_950, [10_000, 10_300, 10_600, 11_900, 12_200])).toBeNull();
    expect(unusualOdometerJump(10_950, [10_000, 10_300, 10_600, 10_900])).toBeNull();
  });
});

describe('stays quiet when it cannot know', () => {
  test(`with fewer than ${MIN_GAPS} gaps to judge by`, () => {
    expect(unusualOdometerJump(20_000, [10_000, 10_300, 10_600])).toBeNull();
    expect(unusualOdometerJump(20_000, [])).toBeNull();
  });

  test('when nothing was logged before this reading', () => {
    expect(unusualOdometerJump(5_000, EVERY_300)).toBeNull();
  });

  test('when the reading equals the last one', () => {
    expect(unusualOdometerJump(10_900, EVERY_300)).toBeNull();
  });

  test.each([
    ['no reading', null],
    ['NaN', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
    ['negative', -5],
    ['zero', 0],
  ])('when the reading is %s', (_label, odometer) => {
    expect(unusualOdometerJump(odometer, EVERY_300)).toBeNull();
  });

  test('garbage in the history is ignored, not trusted', () => {
    const noisy = [Number.NaN, 10_000, Number.POSITIVE_INFINITY, 10_300, -1, 0, 10_600, 10_900];
    expect(unusualOdometerJump(11_550, noisy)?.usual).toBe(300);
  });

  test('a history of one repeated reading has no gaps at all', () => {
    expect(unusualOdometerJump(20_000, [10_000, 10_000, 10_000, 10_000])).toBeNull();
  });

  test('the factor is twice the usual', () => {
    expect(GAP_FACTOR).toBe(2);
  });
});

describe('more edges', () => {
  test('fractional readings, as a metric entry converted to miles produces', () => {
    const history = [10_000.4, 10_300.9, 10_601.2, 10_900.7];
    const jump = unusualOdometerJump(11_600.3, history);
    expect(jump?.previous).toBe(10_900.7);
    expect(jump?.distance).toBeCloseTo(699.6, 6);
  });

  test('an even number of gaps takes the mean of the middle two', () => {
    // Gaps 200, 300, 400, 500 → median 350; 701 is more than twice that.
    const history = [10_000, 10_200, 10_500, 10_900, 11_400];
    expect(unusualOdometerJump(12_101, history)?.usual).toBe(350);
    expect(unusualOdometerJump(12_100, history)).toBeNull();
  });

  test('very large readings do not lose the comparison', () => {
    const base = 9_000_000_000;
    const history = [base, base + 300, base + 600, base + 900];
    expect(unusualOdometerJump(base + 1_600, history)?.distance).toBe(700);
  });

  test('a short car history padded with garbage is still too short', () => {
    expect(unusualOdometerJump(20_000, [10_000, 10_300, Number.NaN, -5, 0, Number.POSITIVE_INFINITY])).toBeNull();
  });

  test('a long history is handled quickly', () => {
    const history = Array.from({ length: 50_000 }, (_, i) => 10_000 + i * 300);
    const started = Date.now();
    expect(unusualOdometerJump(10_000 + 50_000 * 300 + 700, history)).not.toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
