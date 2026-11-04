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
