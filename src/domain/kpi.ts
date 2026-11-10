/**
 * The dashboard's headline stats, ported from `Shared/Statistics/KPI.swift`.
 *
 * A `KPI` is a **value**, not words (#94): which stat it is, its canonical
 * number (miles, US gallons, US MPG, the amount as typed), and what its
 * secondary line is about. The maths already happened in `fuelStatistics.ts`;
 * the words, units and currency are the screen's (`ui/kpiText.ts`). It used
 * to build the card's three strings here — "Total Spent", "Best: …", "/mo
 * avg" — which put English in the domain layer.
 *
 * Two details carried over deliberately:
 *
 * - **`id` is stable across unit changes**, while the title the screen builds
 *   from it is not. Switching to metric rewrites "Avg MPG" into "Avg
 *   L/100km", and a stable key is what lets the list update a card in place
 *   instead of tearing it down and building a new one.
 * - **`value` may be `null`**, meaning "no data yet" — distinct from a
 *   formatted zero. A new vehicle has no economy, and showing "0.0 MPG" would
 *   be a claim rather than an absence.
 *
 * As with the vehicle showdown, the upstream `icon` field is dropped: it holds
 * SF Symbol names, and `id` already identifies each card for the view layer.
 */

import type { FuelStatistics } from './fuelStatistics';
import type { Metric } from './metric';

/** The cards, in display order. */
export const KPI_IDS = [
  'avgEconomy',
  'lastEconomy',
  'totalSpent',
  'costPerDistance',
  'avgPrice',
  'distanceTracked',
  'fillUps',
  'totalVolume',
] as const;

export type KpiId = (typeof KPI_IDS)[number];

/** What a card's secondary line is about, with its canonical value. */
export type KpiDetail =
  | { readonly kind: 'bestEconomy'; readonly mpg: number }
  | { readonly kind: 'monthlySpend'; readonly amount: number }
  | { readonly kind: 'lastPrice'; readonly pricePerGallon: number }
  | { readonly kind: 'milesPerFill'; readonly miles: number }
  | { readonly kind: 'gallonsPerFill'; readonly gallons: number }
  | { readonly kind: 'costPerFill'; readonly amount: number };

export interface KPI {
  readonly id: KpiId;
  /**
   * The canonical value: MPG, an amount, a price per gallon, a cost per mile,
   * miles, a count, gallons. `null` means "no data yet", which is not the same
   * as a zero.
   */
  readonly value: number | null;
  readonly detail: KpiDetail | null;
  readonly metric: Metric;
}

/** The full KPI set for the dashboard, in canonical units. */
export function dashboardKPIs(stats: FuelStatistics): KPI[] {
  return [
    { id: 'avgEconomy', value: stats.averageMPG, detail: null, metric: 'economy' },
    {
      id: 'lastEconomy',
      value: stats.lastMPG,
      detail: stats.bestMPG === null ? null : { kind: 'bestEconomy', mpg: stats.bestMPG },
      metric: 'economy',
    },
    {
      id: 'totalSpent',
      value: stats.totalSpent,
      detail:
        stats.averageMonthlySpend === null ? null : { kind: 'monthlySpend', amount: stats.averageMonthlySpend },
      metric: 'spending',
    },
    { id: 'costPerDistance', value: stats.costPerMile, detail: null, metric: 'spending' },
    {
      id: 'avgPrice',
      value: stats.averagePricePerGallon,
      detail:
        stats.lastPricePerGallon === null ? null : { kind: 'lastPrice', pricePerGallon: stats.lastPricePerGallon },
      metric: 'price',
    },
    {
      id: 'distanceTracked',
      value: stats.milesTracked,
      detail:
        stats.averageMilesBetweenFillUps === null
          ? null
          : { kind: 'milesPerFill', miles: stats.averageMilesBetweenFillUps },
      metric: 'distance',
    },
    {
      id: 'fillUps',
      value: stats.fillUpCount,
      detail:
        stats.averageGallonsPerFillUp === null
          ? null
          : { kind: 'gallonsPerFill', gallons: stats.averageGallonsPerFillUp },
      metric: 'distance',
    },
    {
      id: 'totalVolume',
      value: stats.totalGallons,
      detail: stats.averageFillUpCost === null ? null : { kind: 'costPerFill', amount: stats.averageFillUpCost },
      metric: 'price',
    },
  ];
}
