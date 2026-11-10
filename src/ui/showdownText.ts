/**
 * The vehicle showdown in words (#94): row titles, values in the reader's
 * units and currency, and the spoken label that states the winner.
 *
 * `domain/vehicleShowdown.ts` decides every row on canonical values; this
 * turns them into "Avg MPG", "40.0" and "Civic wins." With `US` and
 * `US_STYLE` it says exactly what the domain module used to.
 */

import type { FuelEntryStats } from '../domain/models';
import type { ShowdownRow, ShowdownRowId, VehicleShowdown, Winner } from '../domain/vehicleShowdown';
import { computeVehicleShowdown } from '../domain/vehicleShowdown';
import type { Metric } from '../domain/metric';
import type { UnitPreferences } from '../domain/units';
import { US, economy as economyUnits, volume as volumeUnits } from '../domain/units';
import type { CurrencyOptions, DisplayStyle } from '../domain/format';
import { US_STYLE, costPerDistance, currency, distance, economy, fuelPrice } from '../domain/format';
import { distanceWords } from './words';

/** One row as the screen shows it. */
export interface ShowdownRowText {
  readonly id: ShowdownRowId;
  readonly title: string;
  readonly metric: Metric;
  /** The formatted value, or `null` where the vehicle has no data for it. */
  readonly left: string | null;
  readonly right: string | null;
  readonly winner: Winner;
}

export interface ShowdownText extends Omit<VehicleShowdown, 'rows' | 'row'> {
  readonly rows: readonly ShowdownRowText[];
  row(id: ShowdownRowId): ShowdownRowText | undefined;
}

export interface ShowdownDisplayOptions extends CurrencyOptions {
  readonly units?: UnitPreferences;
}

/** A row's title in the reader's units. */
export function showdownTitle(id: ShowdownRowId, units: UnitPreferences = US): string {
  switch (id) {
    case 'mpg':
      return `Avg ${economyUnits[units.economy].abbreviation}`;
    case 'cpm':
      return `Cost per ${distanceWords[units.distance].noun}`;
    case 'ppg':
      return `Avg Price/${volumeUnits[units.volume].abbreviation}`;
    case 'miles':
      return `${distanceWords[units.distance].name} Tracked`;
    case 'spent':
      return 'Total Spent';
    case 'fills':
      return 'Fill-Ups';
  }
}

/** A row's canonical value as the screen shows it. */
export function showdownValue(
  id: ShowdownRowId,
  value: number,
  units: UnitPreferences = US,
  style: DisplayStyle = US_STYLE,
): string | null {
  switch (id) {
    case 'mpg':
      return economy(value, units.economy, style.locale);
    case 'cpm':
      return costPerDistance(value, units.distance, style);
    case 'ppg':
      return fuelPrice(value, units.volume, style);
    case 'miles':
      return distance(value, units.distance, false, style.locale);
    case 'spent':
      return currency(value, style);
    case 'fills':
      // Truncating, not rounding — matching the Swift's `Int($0)`. The value is
      // already a whole count; truncation just refuses to invent a 5th fill-up.
      return String(Math.trunc(value));
  }
}

/** The showdown computed and phrased for the screen: rows carry formatted text. */
export function computeShowdownForDisplay(
  leftName: string,
  leftEntries: readonly FuelEntryStats[],
  rightName: string,
  rightEntries: readonly FuelEntryStats[],
  options: ShowdownDisplayOptions = {},
): ShowdownText {
  const units = options.units ?? US;
  const style: DisplayStyle = {
    locale: options.locale ?? US_STYLE.locale,
    currency: options.currency ?? US_STYLE.currency,
  };
  const shown = (id: ShowdownRowId, value: number | null): string | null =>
    value === null ? null : showdownValue(id, value, units, style);
  const showdown = computeVehicleShowdown(leftName, leftEntries, rightName, rightEntries, {
    // Two values that would read the same are a tie: the gap cannot be seen.
    looksEqual: (id, left, right) => shown(id, left) === shown(id, right),
  });
  const rows = showdown.rows.map(
    (row: ShowdownRow): ShowdownRowText => ({
      id: row.id,
      title: showdownTitle(row.id, units),
      metric: row.metric,
      left: shown(row.id, row.left),
      right: shown(row.id, row.right),
      winner: row.winner,
    }),
  );
  const { leftMPGSeries, rightMPGSeries, leftWins, rightWins, hasContest } = showdown;
  return {
    leftName,
    rightName,
    leftMPGSeries,
    rightMPGSeries,
    leftWins,
    rightWins,
    hasContest,
    rows,
    row(id) {
      return rows.find((row) => row.id === id);
    },
  };
}

/**
 * A spoken description of the row, stating the winner **in words**.
 *
 * The on-screen signal is colour, which a screen-reader user cannot hear and a
 * colour-blind reader may not be able to see — so the verdict has to exist as
 * text as well, not only as a highlight.
 */
export function showdownRowLabel(row: ShowdownRowText, leftName: string, rightName: string): string {
  const left = row.left ?? 'no data';
  const right = row.right ?? 'no data';
  let label = `${row.title}. ${leftName}: ${left}. ${rightName}: ${right}.`;
  if (row.winner === 'left') label += ` ${leftName} wins.`;
  else if (row.winner === 'right') label += ` ${rightName} wins.`;
  else if (row.winner === 'tie') label += ' Tie.';
  return label;
}
