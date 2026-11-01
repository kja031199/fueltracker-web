import { describe, expect, it } from 'vitest';
import { MAX_ADOPTED_SKEW_MS, MonotonicClock } from './syncClock';

/** A wall clock the test moves by hand. */
function fixedWall(start: number): { read: () => number; set: (value: number) => void } {
  let value = start;
  return { read: () => value, set: (next) => (value = next) };
}

const NOW = new Date('2026-06-15T12:00:00Z').getTime();

describe('issuing timestamps', () => {
  it('never issues the same value twice, even within one millisecond', () => {
    // shouldReplace compares with `>`, so two writes that tie mean the second
    // one silently loses.
    const clock = new MonotonicClock(() => NOW);
    const issued = [clock.now(), clock.now(), clock.now()];
    expect(new Set(issued).size).toBe(3);
    expect(issued[1]!).toBeGreaterThan(issued[0]!);
    expect(issued[2]!).toBeGreaterThan(issued[1]!);
  });

  it('tracks the wall clock when it is ahead of the floor', () => {
    const wall = fixedWall(NOW);
    const clock = new MonotonicClock(wall.read);
    expect(clock.now()).toBe(NOW);
    wall.set(NOW + 5000);
    expect(clock.now()).toBe(NOW + 5000);
  });

  it('keeps moving forward when the wall clock goes backwards', () => {
    // Daylight saving, an NTP correction, or a user setting the time by hand.
    const wall = fixedWall(NOW);
    const clock = new MonotonicClock(wall.read);
    const before = clock.now();
    wall.set(NOW - 60 * 60 * 1000);
    expect(clock.now()).toBeGreaterThan(before);
  });
});

describe('observing timestamps from elsewhere', () => {
  it('raises the floor above a newer remote timestamp', () => {
    // The whole point: after seeing someone else's row, this device's next
    // write must beat it.
    const clock = new MonotonicClock(() => NOW);
    const remote = NOW + 60 * 60 * 1000;
    expect(clock.observe(remote)).toBe(true);
    expect(clock.now()).toBeGreaterThan(remote);
  });

  it('ignores an older timestamp', () => {
    const clock = new MonotonicClock(() => NOW);
    expect(clock.observe(NOW - 100_000)).toBe(true);
    expect(clock.now()).toBe(NOW);
  });

  it('adopts a skew right up to the bound', () => {
    const clock = new MonotonicClock(() => NOW);
    const edge = NOW + MAX_ADOPTED_SKEW_MS;
    expect(clock.observe(edge)).toBe(true);
    expect(clock.now()).toBeGreaterThan(edge);
  });

  it('refuses a skew just past the bound, and counts it', () => {
    const clock = new MonotonicClock(() => NOW);
    expect(clock.observe(NOW + MAX_ADOPTED_SKEW_MS + 1)).toBe(false);
    expect(clock.refusedCount).toBe(1);
    // The floor is untouched, so this device keeps issuing sane values.
    expect(clock.now()).toBe(NOW);
  });
});

describe('hostile timestamps', () => {
  it('refuses MAX_SAFE_INTEGER without breaking monotonicity', () => {
    // Adopting it would put the floor at the edge of integer precision, where
    // `+ 1` stops producing a larger number — every later write would tie, and
    // under `>` a tie means the newer write loses.
    const clock = new MonotonicClock(() => NOW);
    expect(clock.observe(Number.MAX_SAFE_INTEGER)).toBe(false);

    const first = clock.now();
    const second = clock.now();
    expect(second).toBeGreaterThan(first);
    expect(Number.isSafeInteger(second)).toBe(true);
  });

  it.each([
    ['Infinity', Number.POSITIVE_INFINITY],
    ['NaN', Number.NaN],
    ['a string', '2026-06-15'],
    ['null', null],
    ['undefined', undefined],
    ['an object', { updatedAt: 1 }],
  ])('ignores %s', (_label, value) => {
    const clock = new MonotonicClock(() => NOW);
    expect(clock.observe(value)).toBe(false);
    expect(clock.now()).toBe(NOW);
    expect(Number.isSafeInteger(clock.now())).toBe(true);
  });

  it('does not count a non-number as a clock-skew refusal', () => {
    // Garbage is a validation problem and is reported as one. Counting it here
    // too would tell someone their clock is wrong when it is not.
    const clock = new MonotonicClock(() => NOW);
    clock.observe('nonsense');
    clock.observe(Number.NaN);
    expect(clock.refusedCount).toBe(0);
  });

  it('stops reporting a refusal once it has been reported', () => {
    const clock = new MonotonicClock(() => NOW);
    clock.observe(NOW + MAX_ADOPTED_SKEW_MS + 1);
    expect(clock.refusedCount).toBe(1);
    clock.clearRefusals();
    expect(clock.refusedCount).toBe(0);
  });

  it('survives a long run of absurd values and still issues sane ones', () => {
    const clock = new MonotonicClock(() => NOW);
    for (let i = 0; i < 100; i += 1) clock.observe(Number.MAX_SAFE_INTEGER - i);
    const issued = clock.now();
    expect(Number.isSafeInteger(issued)).toBe(true);
    expect(issued).toBe(NOW);
    expect(clock.refusedCount).toBe(100);
  });
});
