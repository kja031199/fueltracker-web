/**
 * The dashboard's headline stats, ported from `Shared/Statistics/KPI.swift`.
 *
 * A `KPI` is a **formatted** stat, not a number: the maths already happened in
 * `fuelStatistics.ts`, and this turns it into the three strings a card shows.
 * Keeping that step out of the view means the wording and the unit handling are
 * testable without rendering anything.
 *
 * Two details carried over deliberately:
 *
 * - **`id` is stable across unit changes** while `title` is not. Switching to
 *   metric rewrites "Avg MPG" into "Avg L/100km", and a stable key is what lets
 *   the list update a card in place instead of tearing it down and building a
 *   new one.
 * - **`value` may be `null`**, meaning "no data yet" — distinct from a
 *   formatted zero. A new vehicle has no economy, and showing "0.0 MPG" would
 *   be a claim rather than an absence.
 *
 * As with the vehicle showdown, the upstream `icon` field is dropped: it holds
 * SF Symbol names, and `id` already identifies each card for the view layer.
 */

import type { FuelStatistics } from './fuelStatistics';
import type { Metric } from './metric';
import type { UnitPreferences } from './units';
import { US, distance as distanceUnits, economy as economyUnits, volume as volumeUnits } from './units';
import {
  costPerDistance,
  currency,
  distance,
  economy,
  fuelPrice,
  volume,
} from './format';

export interface KPI {
  readonly id: string;
  readonly title: string;
  /** `null` means "no data yet", which is not the same as a formatted zero. */
  readonly value: string | null;
  readonly detail: string | null;
  readonly metric: Metric;
}

/**
 * One spoken phrase combining title, value and detail, so a screen reader reads
 * the card as a single coherent stat rather than three disconnected fragments.
 */
export function kpiAccessibilityLabel(kpi: KPI): string {
  const parts = [kpi.title, kpi.value ?? 'no data yet'];
  if (kpi.detail !== null) parts.push(kpi.detail);
  return parts.join(', ');
}

/** The full KPI set for the dashboard, rendered in the given units. */
export function dashboardKPIs(stats: FuelStatistics, units: UnitPreferences = US): KPI[] {
  const economySpec = economyUnits[units.economy];
  const distanceSpec = distanceUnits[units.distance];
  const volumeSpec = volumeUnits[units.volume];

  const money = (value: number): string => currency(value);

  return [
    {
      id: 'avgEconomy',
      title: `Avg ${economySpec.abbreviation}`,
      value: stats.averageMPG === null ? null : economy(stats.averageMPG, units.economy),
      detail: null,
      metric: 'economy',
    },
    {
      id: 'lastEconomy',
      title: `Last ${economySpec.abbreviation}`,
      value: stats.lastMPG === null ? null : economy(stats.lastMPG, units.economy),
      detail:
        stats.bestMPG === null
          ? null
          : `Best: ${economy(stats.bestMPG, units.economy) ?? '—'}`,
      metric: 'economy',
    },
    {
      id: 'totalSpent',
      title: 'Total Spent',
      value: money(stats.totalSpent),
      detail:
        stats.averageMonthlySpend === null ? null : `${money(stats.averageMonthlySpend)}/mo avg`,
      metric: 'spending',
    },
    {
      id: 'costPerDistance',
      title: `Cost per ${distanceSpec.singularNoun}`,
      value: stats.costPerMile === null ? null : costPerDistance(stats.costPerMile, units.distance),
      detail: null,
      metric: 'spending',
    },
    {
      id: 'avgPrice',
      title: `Avg Price/${volumeSpec.abbreviation}`,
      value:
        stats.averagePricePerGallon === null
          ? null
          : fuelPrice(stats.averagePricePerGallon, units.volume),
      detail:
        stats.lastPricePerGallon === null
          ? null
          : `Last: ${fuelPrice(stats.lastPricePerGallon, units.volume)}`,
      metric: 'price',
    },
    {
      id: 'distanceTracked',
      title: `${distanceSpec.name} Tracked`,
      value: distance(stats.milesTracked, units.distance),
      detail:
        stats.averageMilesBetweenFillUps === null
          ? null
          : `${distance(stats.averageMilesBetweenFillUps, units.distance)} ${distanceSpec.abbreviation}/fill avg`,
      metric: 'distance',
    },
    {
      id: 'fillUps',
      title: 'Fill-Ups',
      value: String(stats.fillUpCount),
      detail:
        stats.averageGallonsPerFillUp === null
          ? null
          : `${volume(stats.averageGallonsPerFillUp, units.volume)} ${volumeSpec.abbreviation} avg`,
      metric: 'distance',
    },
    {
      id: 'totalVolume',
      title: `Total ${volumeSpec.name}`,
      value: volume(stats.totalGallons, units.volume),
      detail:
        stats.averageFillUpCost === null ? null : `${money(stats.averageFillUpCost)}/fill avg`,
      metric: 'price',
    },
  ];
}
