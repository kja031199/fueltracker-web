/**
 * A head-to-head comparison of two vehicles, ported from
 * `Shared/Statistics/VehicleShowdown.swift`.
 *
 * Six rows. Three can be won — economy, cost per distance, price per volume —
 * and three are informational, because a lower number there can simply mean
 * less driving rather than a better vehicle.
 *
 * ## Winners are decided on canonical values
 *
 * This is the load-bearing rule, and the whole units system rests on it.
 * Ranking happens on stored miles / US gallons / US MPG; only the strings and
 * the row titles — which the screen builds, `ui/showdownText.ts` (#94) —
 * change with the reader's unit choice. It matters most for
 * economy: **L/100km is the reciprocal of MPG**, so a better vehicle shows a
 * *lower* number, and a comparison done on displayed values would hand every
 * economy row to the wrong vehicle for half the world.
 *
 * ## No `icon` field
 *
 * Upstream carries SF Symbol names (`"leaf.fill"`, `"fuelpump.fill"`). Those
 * mean nothing off Apple's platforms, and `id` already identifies every row
 * uniquely — so the UI layer maps `id` to whatever icon set it picks, and the
 * domain module stays platform-free.
 */

import type { FuelEntryStats, DateValuePoint } from './models';
import { computeFuelStatistics } from './fuelStatistics';
import type { Metric } from './metric';

/**
 * The outcome of one row.
 *
 * `notContested` is deliberately **not** named `none`. Upstream renamed it to
 * dodge a collision with `Optional.none`, where `row?.winner == .none` silently
 * tests for nil instead of the case. TypeScript has the same trap wearing
 * different clothes — `showdown.rows.find(...)?.winner === undefined` is true
 * when the row is missing, not when it is uncontested — so the reasoning
 * survives the port and the name stays.
 */
export type Winner = 'left' | 'right' | 'tie' | 'notContested';

/** Below this the two values are the same number as far as a reader cares. */
export const WINNER_EPSILON = 0.0001;

/** The rows that can be won, in order. Everything else is informational. */
export const CONTESTED_ROW_IDS = ['mpg', 'cpm', 'ppg'] as const;

/** Every row id, in display order. The UI keys its icons and layout off these. */
export const SHOWDOWN_ROW_IDS = ['mpg', 'cpm', 'ppg', 'miles', 'spent', 'fills'] as const;

export type ShowdownRowId = (typeof SHOWDOWN_ROW_IDS)[number];

/**
 * One row comparing a metric across two vehicles: canonical values (MPG, cost
 * per mile, price per gallon, miles, amount, count), not words (#94).
 */
export interface ShowdownRow {
  readonly id: ShowdownRowId;
  readonly metric: Metric;
  /** The canonical value, or `null` where the vehicle has no data for it. */
  readonly left: number | null;
  readonly right: number | null;
  readonly winner: Winner;
}

export interface VehicleShowdown {
  readonly leftName: string;
  readonly rightName: string;
  readonly leftMPGSeries: readonly DateValuePoint[];
  readonly rightMPGSeries: readonly DateValuePoint[];
  readonly rows: readonly ShowdownRow[];
  /** Contested rows won by each side, for a verdict line. */
  readonly leftWins: number;
  readonly rightWins: number;
  /**
   * True when at least one contested metric had data on both sides — which is
   * what lets a verdict tell "too close to call" apart from "no data yet".
   */
  readonly hasContest: boolean;
  row(id: ShowdownRowId): ShowdownRow | undefined;
}

/**
 * Decides a contested row.
 *
 * A missing value on either side means there is nothing to compare — **not** a
 * win for the side that has data. Non-finite values are treated the same way:
 * without that guard a `NaN` from a corrupted record would lose every
 * comparison and an `Infinity` would win every one, silently.
 */
export function decideWinner(
  left: number | null | undefined,
  right: number | null | undefined,
  lowerIsBetter: boolean,
): Winner {
  if (left === null || left === undefined || right === null || right === undefined) {
    return 'notContested';
  }
  if (!Number.isFinite(left) || !Number.isFinite(right)) return 'notContested';
  if (Math.abs(left - right) < WINNER_EPSILON) return 'tie';
  const leftBetter = lowerIsBetter ? left < right : left > right;
  return leftBetter ? 'left' : 'right';
}

export interface ShowdownOptions {
  /**
   * Whether the screen would show two values of a row identically. If it would,
   * the gap is too small to see, and highlighting one side as the winner over a
   * difference the reader cannot read ("$3.000" vs "$3.000") is just confusing —
   * so the row is a tie. The screen knows its own formatting, so it says
   * (`ui/showdownText.ts`); without it, only `decideWinner` decides.
   */
  readonly looksEqual?: (id: ShowdownRowId, left: number, right: number) => boolean;
}

interface ContestSpec {
  readonly id: ShowdownRowId;
  readonly metric: Metric;
  readonly left: number | null;
  readonly right: number | null;
  readonly lowerIsBetter: boolean;
}

function contest(spec: ContestSpec, options: ShowdownOptions): ShowdownRow {
  let winner = decideWinner(spec.left, spec.right, spec.lowerIsBetter);
  if (
    (winner === 'left' || winner === 'right') &&
    spec.left !== null &&
    spec.right !== null &&
    options.looksEqual?.(spec.id, spec.left, spec.right) === true
  ) {
    winner = 'tie';
  }
  return { id: spec.id, metric: spec.metric, left: spec.left, right: spec.right, winner };
}

function info(id: ShowdownRowId, metric: Metric, left: number, right: number): ShowdownRow {
  return { id, metric, left, right, winner: 'notContested' };
}

export function computeVehicleShowdown(
  leftName: string,
  leftEntries: readonly FuelEntryStats[],
  rightName: string,
  rightEntries: readonly FuelEntryStats[],
  options: ShowdownOptions = {},
): VehicleShowdown {
  const left = computeFuelStatistics(leftEntries);
  const right = computeFuelStatistics(rightEntries);

  const rows: ShowdownRow[] = [
    // Canonical MPG: higher is better regardless of how it will be displayed.
    contest({ id: 'mpg', metric: 'economy', left: left.averageMPG, right: right.averageMPG, lowerIsBetter: false }, options),
    contest({ id: 'cpm', metric: 'spending', left: left.costPerMile, right: right.costPerMile, lowerIsBetter: true }, options),
    contest(
      { id: 'ppg', metric: 'price', left: left.averagePricePerGallon, right: right.averagePricePerGallon, lowerIsBetter: true },
      options,
    ),
    // Informational — lower is not inherently "better" here (it can just mean
    // less driving), so these have no winner.
    info('miles', 'distance', left.milesTracked, right.milesTracked),
    info('spent', 'spending', left.totalSpent, right.totalSpent),
    info('fills', 'distance', left.fillUpCount, right.fillUpCount),
  ];

  return {
    leftName,
    rightName,
    leftMPGSeries: left.mpgSeries,
    rightMPGSeries: right.mpgSeries,
    rows,
    leftWins: rows.filter((r) => r.winner === 'left').length,
    rightWins: rows.filter((r) => r.winner === 'right').length,
    hasContest: rows.some((r) => r.winner !== 'notContested'),
    row(id) {
      return rows.find((r) => r.id === id);
    },
  };
}
