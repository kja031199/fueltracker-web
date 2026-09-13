import { describe, expect, test } from 'vitest';
import type { FuelEntryStats } from './models';
import { economy, fuelPrice } from './format';
import { ECONOMY_UNITS, METRIC, US } from './units';
import type { UnitPreferences } from './units';
import {
  SHOWDOWN_ROW_IDS,
  WINNER_EPSILON,
  computeVehicleShowdown,
  decideWinner,
  showdownRowLabel,
} from './vehicleShowdown';

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

describe('row-level outcomes', () => {
  test('higher MPG and lower cost per mile win their rows', () => {
    const showdown = computeVehicleShowdown(
      'Eff', efficient(3.0), 'Guzzler', thirsty(3.0),
    );
    expect(showdown.row('mpg')?.winner).toBe('left'); // 40 > 25
    expect(showdown.row('cpm')?.winner).toBe('left'); // 0.075 < 0.12
    expect(showdown.row('ppg')?.winner).toBe('tie'); // both $3.00
    expect(showdown.leftWins).toBe(2);
    expect(showdown.rightWins).toBe(0);
    expect(showdown.hasContest).toBe(true);
  });

  test('a split decision counts wins per side', () => {
    // Efficient but pricey vs thirsty but cheap: the cheap one wins on price
    // and cost per mile, the efficient one only on MPG.
    const showdown = computeVehicleShowdown(
      'Eff', efficient(3.6), 'Cheap', thirsty(2.0),
    );
    expect(showdown.row('mpg')?.winner).toBe('left'); // 40 > 25
    expect(showdown.row('ppg')?.winner).toBe('right'); // $2.00 < $3.60
    expect(showdown.row('cpm')?.winner).toBe('right'); // 0.08 < 0.09
    expect(showdown.leftWins).toBe(1);
    expect(showdown.rightWins).toBe(2);
  });

  test('informational rows never have a winner', () => {
    const showdown = computeVehicleShowdown(
      'Eff', efficient(3.0), 'Guzzler', thirsty(3.0),
    );
    // Miles, spending and fill-ups all differ, but none is a "win" — a lower
    // number there can simply mean less driving.
    expect(showdown.row('miles')?.winner).toBe('notContested');
    expect(showdown.row('spent')?.winner).toBe('notContested');
    expect(showdown.row('fills')?.winner).toBe('notContested');
  });

  test('missing data means no contest for that row', () => {
    // The right vehicle has a single fill: no MPG, no cost per mile, but it
    // does have a price. Only the price row is a contest.
    const showdown = computeVehicleShowdown(
      'Eff', efficient(3.0), 'New', [mk(1, 30_000, 10, 3.1)],
    );
    expect(showdown.row('mpg')?.winner).toBe('notContested');
    expect(showdown.row('cpm')?.winner).toBe('notContested');
    expect(showdown.row('ppg')?.winner).toBe('left'); // $3.00 < $3.10
    expect(showdown.leftWins).toBe(1);
    expect(showdown.hasContest).toBe(true);
  });

  test('cost per mile can contest even when MPG cannot', () => {
    // A partial-tank-only history yields no full-tank MPG, but it still has
    // miles and spending — so cost per mile is a real contest while MPG is not.
    const partialOnly = [
      mk(1, 10_000, 10, 3.0, false),
      mk(10, 10_300, 10, 3.0, false),
      mk(20, 10_600, 10, 3.0, false),
    ];
    const showdown = computeVehicleShowdown(
      'Partial', partialOnly, 'Normal', thirsty(3.2),
    );
    expect(showdown.row('mpg')?.left).toBeNull();
    expect(showdown.row('mpg')?.winner).toBe('notContested');
    expect(showdown.row('cpm')?.left).not.toBeNull();
    expect(showdown.row('cpm')?.winner).not.toBe('notContested');
  });

  test('two brand-new vehicles contest only on price', () => {
    const showdown = computeVehicleShowdown(
      'A', [mk(1, 10_000, 10, 3.0)], 'B', [mk(1, 20_000, 10, 3.5)],
    );
    expect(showdown.row('mpg')?.winner).toBe('notContested');
    expect(showdown.row('cpm')?.winner).toBe('notContested');
    expect(showdown.row('ppg')?.winner).toBe('left');
    expect(showdown.hasContest).toBe(true);
    expect(showdown.leftWins + showdown.rightWins).toBe(1);
  });
});

describe('units change the display, never the verdict', () => {
  // The load-bearing rule of the whole units system. L/100km is the reciprocal
  // of MPG, so a better vehicle shows a LOWER number — a comparison done on
  // displayed values would hand every economy row to the wrong vehicle.
  const winnersUnder = (units: UnitPreferences): string[] =>
    computeVehicleShowdown('Eff', efficient(3.6), 'Cheap', thirsty(2.0), { units })
      .rows.map((r) => r.winner);

  test('the winner column is identical under US and metric preferences', () => {
    expect(winnersUnder(METRIC)).toEqual(winnersUnder(US));
  });

  test('and under every economy unit, including the inverted one', () => {
    const baseline = winnersUnder(US);
    for (const unit of ECONOMY_UNITS) {
      expect(winnersUnder({ ...METRIC, economy: unit }), unit).toEqual(baseline);
    }
  });

  test('the economy row still reads lower-is-better in L/100km', () => {
    // Proves the displayed numbers really do invert, so the test above is
    // asserting something rather than comparing two identical renderings.
    const metricShow = computeVehicleShowdown(
      'Eff', efficient(3.6), 'Cheap', thirsty(2.0),
      { units: { ...METRIC, economy: 'litersPer100km' } },
    );
    const left = Number(metricShow.row('mpg')?.left);
    const right = Number(metricShow.row('mpg')?.right);
    expect(left).toBeLessThan(right); // fewer litres per 100 km
    expect(metricShow.row('mpg')?.winner).toBe('left'); // ...and still wins
  });

  test('row titles carry the reader unit names', () => {
    const us = computeVehicleShowdown('A', efficient(3.0), 'B', thirsty(3.0), { units: US });
    const metric = computeVehicleShowdown('A', efficient(3.0), 'B', thirsty(3.0), { units: METRIC });
    expect(us.row('mpg')?.title).toBe('Avg MPG');
    expect(us.row('cpm')?.title).toBe('Cost per Mile');
    expect(us.row('ppg')?.title).toBe('Avg Price/gal');
    expect(us.row('miles')?.title).toBe('Miles Tracked');
    expect(metric.row('cpm')?.title).toBe('Cost per Kilometer');
    expect(metric.row('ppg')?.title).toBe('Avg Price/L');
    expect(metric.row('miles')?.title).toBe('Kilometers Tracked');
  });
});

describe('formatting, series and structure', () => {
  test('row values are formatted', () => {
    const showdown = computeVehicleShowdown(
      'Eff', efficient(3.0), 'Guzzler', thirsty(3.2),
    );
    expect(showdown.row('mpg')?.left).toBe(economy(40, 'mpg'));
    expect(showdown.row('mpg')?.right).toBe(economy(25, 'mpg'));
    expect(showdown.row('ppg')?.right).toBe(fuelPrice(3.2, 'gallons'));
  });

  test('MPG series are exposed per vehicle', () => {
    const showdown = computeVehicleShowdown(
      'Eff', efficient(3.0), 'Guzzler', thirsty(3.0),
    );
    expect(showdown.leftMPGSeries).toHaveLength(2);
    expect(showdown.rightMPGSeries).toHaveLength(2);
  });

  test('rows have stable ids and order', () => {
    const showdown = computeVehicleShowdown('A', efficient(3.0), 'B', thirsty(3.0));
    expect(showdown.rows.map((r) => r.id)).toEqual([...SHOWDOWN_ROW_IDS]);
  });

  test('the row order holds for every input shape', () => {
    // The UI and its tests key off these, so order must not depend on data.
    const shapes: [FuelEntryStats[], FuelEntryStats[]][] = [
      [[], []],
      [efficient(3.0), []],
      [[mk(1, 10_000, 10, 3.0)], thirsty(3.0)],
      [efficient(3.0), efficient(3.0)],
    ];
    for (const [left, right] of shapes) {
      const showdown = computeVehicleShowdown('A', left, 'B', right);
      expect(showdown.rows.map((r) => r.id)).toEqual([...SHOWDOWN_ROW_IDS]);
    }
  });

  test('fill-up counts truncate rather than round', () => {
    const showdown = computeVehicleShowdown('A', efficient(3.0), 'B', [mk(1, 1, 1, 1)]);
    expect(showdown.row('fills')?.left).toBe('3');
    expect(showdown.row('fills')?.right).toBe('1');
  });
});

describe('the spoken row label', () => {
  test('states the winner in words, not only in colour', () => {
    const showdown = computeVehicleShowdown('Eff', efficient(3.0), 'Guzzler', thirsty(3.0));
    const mpg = showdown.row('mpg')!;
    const label = showdownRowLabel(mpg, 'Eff', 'Guzzler');
    expect(label).toContain('Avg MPG');
    expect(label).toContain('Eff: 40.0');
    expect(label).toContain('Guzzler: 25.0');
    expect(label).toContain('Eff wins.');
  });

  test('says "no data" rather than leaving a gap', () => {
    const showdown = computeVehicleShowdown('A', [mk(1, 10_000, 10, 3.0)], 'B', thirsty(3.0));
    const label = showdownRowLabel(showdown.row('mpg')!, 'A', 'B');
    expect(label).toContain('A: no data');
    expect(label).not.toContain('wins');
  });

  test('names a tie, and stays silent on an uncontested row', () => {
    const showdown = computeVehicleShowdown('A', efficient(3.0), 'B', efficient(3.0));
    expect(showdownRowLabel(showdown.row('ppg')!, 'A', 'B')).toContain('Tie.');
    const info = showdownRowLabel(showdown.row('spent')!, 'A', 'B');
    expect(info).not.toContain('wins');
    expect(info).not.toContain('Tie');
  });
});

describe('degenerate and hostile input', () => {
  test('two empty vehicles have no contest', () => {
    const showdown = computeVehicleShowdown('A', [], 'B', []);
    expect(showdown.rows).toHaveLength(6);
    expect(showdown.rows.every((r) => r.winner === 'notContested')).toBe(true);
    expect(showdown.hasContest).toBe(false);
    expect(showdown.leftWins).toBe(0);
    expect(showdown.rightWins).toBe(0);
    expect(showdown.leftMPGSeries).toHaveLength(0);
  });

  test('identical vehicles tie every contested row with no winner', () => {
    const showdown = computeVehicleShowdown('A', efficient(3.0), 'B', efficient(3.0));
    expect(showdown.row('mpg')?.winner).toBe('tie');
    expect(showdown.row('cpm')?.winner).toBe('tie');
    expect(showdown.row('ppg')?.winner).toBe('tie');
    expect(showdown.leftWins).toBe(0);
    expect(showdown.rightWins).toBe(0);
    expect(showdown.hasContest).toBe(true); // there IS data — just no winner
  });

  test('differences too small to see are shown as ties', () => {
    // Two vehicles whose price differs only in the 4th decimal. Both render as
    // "$3.000", so highlighting one as the winner would be confusing — the row
    // must read as a tie, not a win.
    const showdown = computeVehicleShowdown(
      'A', [mk(1, 10_000, 10, 3.0001)], 'B', [mk(1, 20_000, 10, 3.0003)],
    );
    const ppg = showdown.row('ppg');
    expect(ppg?.left).toBe(ppg?.right); // identical as displayed
    expect(ppg?.winner).toBe('tie'); // ...so nobody "wins"
    expect(showdown.leftWins).toBe(0);
    expect(showdown.rightWins).toBe(0);
  });

  test('the display tie applies per unit, not only in gallons', () => {
    // The same two prices converted to litres also collapse to one string, so
    // the downgrade has to happen after formatting rather than before it.
    const showdown = computeVehicleShowdown(
      'A', [mk(1, 10_000, 10, 3.0001)], 'B', [mk(1, 20_000, 10, 3.0003)],
      { units: METRIC },
    );
    expect(showdown.row('ppg')?.winner).toBe('tie');
  });

  test('the result is independent of entry order', () => {
    const ordered = efficient(3.1);
    const arrangements = [
      ordered,
      [...ordered].reverse(),
      [ordered[2]!, ordered[0]!, ordered[1]!],
    ];
    const outcomes = arrangements.map((entries) =>
      computeVehicleShowdown('A', entries, 'B', thirsty(3.1)).rows.map((r) => r.winner),
    );
    for (const outcome of outcomes.slice(1)) expect(outcome).toEqual(outcomes[0]);
  });

  test('duplicate odometer readings do not crown a phantom winner', () => {
    // Two entries share an odometer (a zero-mile "segment"). It must be
    // skipped, not divided by zero into an infinite MPG that wins.
    const dupes = [
      mk(1, 10_000, 10, 3.0),
      mk(2, 10_000, 10, 3.0), // same odometer
      mk(10, 10_400, 10, 3.0),
    ];
    const showdown = computeVehicleShowdown('Dupes', dupes, 'Normal', thirsty(3.0));
    const mpg = showdown.row('mpg')?.left;
    if (mpg !== null && mpg !== undefined) {
      expect(mpg).not.toMatch(/NaN|Infinity|∞/i);
    }
    expect(showdown.leftWins + showdown.rightWins).toBeLessThanOrEqual(3);
  });

  test('a zero-gallon fill produces no infinite winner', () => {
    const freeAir = [mk(1, 10_000, 0.0001, 3.0), mk(10, 10_400, 10, 3.0)];
    const showdown = computeVehicleShowdown('Odd', freeAir, 'Normal', thirsty(3.0));
    for (const row of showdown.rows) {
      if (row.left !== null) expect(row.left).not.toMatch(/NaN|Infinity|∞/i);
      if (row.right !== null) expect(row.right).not.toMatch(/NaN|Infinity|∞/i);
    }
  });

  test('a free fill-up does not decide the price row by divide-by-zero', () => {
    const free = [mk(1, 10_000, 10, 0), mk(10, 10_400, 10, 0)];
    const showdown = computeVehicleShowdown('Free', free, 'Normal', thirsty(3.0));
    expect(showdown.leftWins + showdown.rightWins).toBeLessThanOrEqual(3);
    for (const row of showdown.rows) {
      if (row.left !== null) expect(row.left).not.toMatch(/NaN|Infinity|∞/i);
    }
  });

  test('win counts never exceed the three contested rows', () => {
    // Structural invariant: only mpg/cpm/ppg can be won, on any input.
    const showdown = computeVehicleShowdown('A', efficient(3.6), 'B', thirsty(2.0));
    expect(showdown.leftWins).toBeLessThanOrEqual(3);
    expect(showdown.rightWins).toBeLessThanOrEqual(3);
    expect(showdown.leftWins + showdown.rightWins).toBeLessThanOrEqual(3);
  });

  test('an unknown row id returns undefined rather than throwing', () => {
    const showdown = computeVehicleShowdown('A', [], 'B', []);
    // @ts-expect-error — the point is what happens when JS callers pass junk.
    expect(showdown.row('nope')).toBeUndefined();
  });
});
