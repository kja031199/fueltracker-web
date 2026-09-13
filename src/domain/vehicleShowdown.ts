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
 * the row titles change with the reader's unit choice. It matters most for
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
import type { UnitPreferences } from './units';
import { US, distance as distanceUnits, economy as economyUnits, volume as volumeUnits } from './units';
import type { CurrencyOptions } from './format';
import { costPerDistance, currency, distance, economy, fuelPrice } from './format';

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

/** One row comparing a metric across two vehicles. */
export interface ShowdownRow {
  readonly id: ShowdownRowId;
  readonly title: string;
  readonly metric: Metric;
  /** Formatted value, or `null` where the vehicle has no data for it. */
  readonly left: string | null;
  readonly right: string | null;
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

/**
 * A spoken description of the row, stating the winner **in words**.
 *
 * The on-screen signal is colour, which a screen-reader user cannot hear and a
 * colour-blind reader may not be able to see — so the verdict has to exist as
 * text as well, not only as a highlight.
 */
export function showdownRowLabel(
  row: ShowdownRow,
  leftName: string,
  rightName: string,
): string {
  const left = row.left ?? 'no data';
  const right = row.right ?? 'no data';
  let label = `${row.title}. ${leftName}: ${left}. ${rightName}: ${right}.`;
  if (row.winner === 'left') label += ` ${leftName} wins.`;
  else if (row.winner === 'right') label += ` ${rightName} wins.`;
  else if (row.winner === 'tie') label += ' Tie.';
  return label;
}

export interface ShowdownOptions extends CurrencyOptions {
  readonly units?: UnitPreferences;
}

interface ContestSpec {
  readonly id: ShowdownRowId;
  readonly title: string;
  readonly metric: Metric;
  readonly left: number | null;
  readonly right: number | null;
  readonly lowerIsBetter: boolean;
  readonly format: (value: number) => string | null;
}

function contest(spec: ContestSpec): ShowdownRow {
  const leftText = spec.left === null ? null : spec.format(spec.left);
  const rightText = spec.right === null ? null : spec.format(spec.right);
  let winner = decideWinner(spec.left, spec.right, spec.lowerIsBetter);
  // If both sides render to the same text, the gap is too small to see.
  // Highlighting one as the winner over a difference the reader cannot read
  // (e.g. "$3.000" vs "$3.000") is just confusing, so call it a tie.
  if ((winner === 'left' || winner === 'right') && leftText === rightText) {
    winner = 'tie';
  }
  return {
    id: spec.id,
    title: spec.title,
    metric: spec.metric,
    left: leftText,
    right: rightText,
    winner,
  };
}

function info(
  id: ShowdownRowId,
  title: string,
  metric: Metric,
  left: number,
  right: number,
  format: (value: number) => string,
): ShowdownRow {
  return { id, title, metric, left: format(left), right: format(right), winner: 'notContested' };
}

export function computeVehicleShowdown(
  leftName: string,
  leftEntries: readonly FuelEntryStats[],
  rightName: string,
  rightEntries: readonly FuelEntryStats[],
  options: ShowdownOptions = {},
): VehicleShowdown {
  const units = options.units ?? US;
  // Spread-if-present rather than passing `undefined` through: the project
  // compiles with `exactOptionalPropertyTypes`, where an explicit `undefined`
  // is not the same as an absent key.
  const money: CurrencyOptions = {
    ...(options.locale !== undefined ? { locale: options.locale } : {}),
    ...(options.currency !== undefined ? { currency: options.currency } : {}),
  };

  const left = computeFuelStatistics(leftEntries);
  const right = computeFuelStatistics(rightEntries);

  const volumeSpec = volumeUnits[units.volume];
  const distanceSpec = distanceUnits[units.distance];
  const economySpec = economyUnits[units.economy];

  const rows: ShowdownRow[] = [
    contest({
      id: 'mpg',
      title: `Avg ${economySpec.abbreviation}`,
      metric: 'economy',
      left: left.averageMPG,
      right: right.averageMPG,
      // Canonical MPG: higher is better regardless of how it will be displayed.
      lowerIsBetter: false,
      format: (value) => economy(value, units.economy),
    }),
    contest({
      id: 'cpm',
      title: `Cost per ${distanceSpec.singularNoun}`,
      metric: 'spending',
      left: left.costPerMile,
      right: right.costPerMile,
      lowerIsBetter: true,
      format: (value) => costPerDistance(value, units.distance, money),
    }),
    contest({
      id: 'ppg',
      title: `Avg Price/${volumeSpec.abbreviation}`,
      metric: 'price',
      left: left.averagePricePerGallon,
      right: right.averagePricePerGallon,
      lowerIsBetter: true,
      format: (value) => fuelPrice(value, units.volume, money),
    }),
    // Informational — lower is not inherently "better" here (it can just mean
    // less driving), so these have no winner.
    info(
      'miles',
      `${distanceSpec.name} Tracked`,
      'distance',
      left.milesTracked,
      right.milesTracked,
      (value) => distance(value, units.distance),
    ),
    info('spent', 'Total Spent', 'spending', left.totalSpent, right.totalSpent, (value) =>
      currency(value, money),
    ),
    // Truncating, not rounding — matching the Swift's `Int($0)`. The value is
    // already a whole count; truncation just refuses to invent a 5th fill-up.
    info('fills', 'Fill-Ups', 'distance', left.fillUpCount, right.fillUpCount, (value) =>
      String(Math.trunc(value)),
    ),
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
