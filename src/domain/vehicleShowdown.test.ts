import { describe, expect, test } from 'vitest';
import type { FuelEntryStats } from './models';
import { SHOWDOWN_ROW_IDS, WINNER_EPSILON, computeVehicleShowdown, decideWinner } from './vehicleShowdown';

const day = (dayOfMonth: number): Date => new Date(2025, 0, dayOfMonth);

let nextId = 0;
function mk(
  dayOfMonth: number,
  odometer: number,
  gallons: number,
  price: number,
  isFullTank = true,
): FuelEntryStats {
  nextId += 1;
  return {
    id: `e${nextId}`,
    date: day(dayOfMonth),
    odometer,
    gallons,
    pricePerGallon: price,
    isFullTank,
    missedPreviousFillUp: false,
  };
}

/** ~40 MPG history (two 400-mile / 10-gal segments) at the given price. */
const efficient = (price: number): FuelEntryStats[] => [
  mk(1, 10_000, 10, price),
  mk(10, 10_400, 10, price),
  mk(20, 10_800, 10, price),
];

/** ~25 MPG history (two 250-mile / 10-gal segments) at the given price. */
const thirsty = (price: number): FuelEntryStats[] => [
  mk(1, 20_000, 10, price),
  mk(10, 20_250, 10, price),
  mk(20, 20_500, 10, price),
];

describe('decideWinner', () => {
  test('resolves directions, ties and missing data', () => {
    // Higher is better.
    expect(decideWinner(40, 25, false)).toBe('left');
    expect(decideWinner(25, 40, false)).toBe('right');
    // Lower is better.
    expect(decideWinner(0.08, 0.1, true)).toBe('left');
    expect(decideWinner(0.1, 0.08, true)).toBe('right');
    // Ties, including within the epsilon.
    expect(decideWinner(30, 30, false)).toBe('tie');
    expect(decideWinner(30, 30.00005, false)).toBe('tie');
    // A missing side is no contest, not a win for the side with data.
    expect(decideWinner(null, 30, false)).toBe('notContested');
    expect(decideWinner(30, null, false)).toBe('notContested');
    expect(decideWinner(null, null, false)).toBe('notContested');
  });

  test('treats non-finite values as no contest', () => {
    // Garbage stats must not silently win or lose every comparison — without
    // the guard, NaN loses them all and Infinity wins them all.
    expect(decideWinner(Number.NaN, 25, false)).toBe('notContested');
    expect(decideWinner(25, Number.NaN, false)).toBe('notContested');
    expect(decideWinner(Number.NaN, Number.NaN, true)).toBe('notContested');
    expect(decideWinner(Number.POSITIVE_INFINITY, 25, true)).toBe('notContested');
    expect(decideWinner(0.1, Number.NEGATIVE_INFINITY, true)).toBe('notContested');
  });

  test('has a consistent epsilon boundary', () => {
    expect(decideWinner(30.0, 30.00001, false)).toBe('tie');
    expect(decideWinner(30.0, 30.001, false)).toBe('right');
    expect(decideWinner(30.0, 30.001, true)).toBe('left');
    // Negative garbage still resolves by direction without throwing.
    expect(decideWinner(-5, -3, true)).toBe('left');
  });

  test('the epsilon is strict on both sides of itself', () => {
    // Pins the constant rather than a value comfortably inside it.
    expect(decideWinner(1, 1 + WINNER_EPSILON / 2, false)).toBe('tie');
    expect(decideWinner(1, 1 + WINNER_EPSILON * 2, false)).toBe('right');
  });

  test('undefined is handled like null, not like a number', () => {
    // `find()` returns undefined, so an undefined value will reach here.
    expect(decideWinner(undefined, 30, false)).toBe('notContested');
    expect(decideWinner(30, undefined, false)).toBe('notContested');
  });
});

describe('rows carry canonical values, not words (#94)', () => {
  test('every row, in order, with numbers', () => {
    const showdown = computeVehicleShowdown('Eff', efficient(3.0), 'Thirsty', thirsty(3.0));
    expect(showdown.rows.map((row) => row.id)).toEqual([...SHOWDOWN_ROW_IDS]);
    expect(showdown.row('mpg')).toMatchObject({ left: 40, right: 25, winner: 'left' });
    expect(showdown.row('fills')).toMatchObject({ left: 3, right: 3, winner: 'notContested' });
    for (const row of showdown.rows) {
      expect(typeof row.left === 'number' || row.left === null).toBe(true);
      expect(row).not.toHaveProperty('title');
    }
  });

  test('a win the screen would show as equal is a tie, and only then', () => {
    const asked: string[] = [];
    const showdown = computeVehicleShowdown('Eff', efficient(3.0), 'Thirsty', thirsty(3.0), {
      looksEqual: (id) => {
        asked.push(id);
        return id === 'mpg';
      },
    });
    expect(showdown.row('mpg')?.winner).toBe('tie');
    expect(showdown.row('cpm')?.winner).toBe('left');
    // Asked about contested wins only: never a tie already, never an informational row.
    expect(asked).not.toContain('ppg');
    expect(asked).not.toContain('miles');
  });

  test('without the hook, only the numbers decide', () => {
    const showdown = computeVehicleShowdown('Eff', efficient(3.0), 'Thirsty', thirsty(3.0));
    expect(showdown.row('mpg')?.winner).toBe('left');
  });
});
