/**
 * A dashboard card in words (#94): the title, the value in the reader's units
 * and currency, the secondary line, and the one phrase a screen reader hears.
 *
 * `domain/kpi.ts` hands over canonical values; this is where they become
 * "Avg MPG", "$90.00" and "$30.00/mo avg". With `US` and `US_STYLE` it says
 * exactly what the domain module used to.
 */

import type { KPI, KpiDetail } from '../domain/kpi';
import type { UnitPreferences } from '../domain/units';
import { US, distance as distanceUnits, economy as economyUnits, volume as volumeUnits } from '../domain/units';
import type { DisplayStyle } from '../domain/format';
import { US_STYLE, costPerDistance, currency, distance, economy, fuelPrice, volume } from '../domain/format';

export interface KpiText {
  readonly title: string;
  /** `null` means "no data yet", which is not the same as a formatted zero. */
  readonly value: string | null;
  readonly detail: string | null;
  /**
   * One spoken phrase combining title, value and detail, so a screen reader
   * reads the card as a single stat rather than three disconnected fragments.
   */
  readonly label: string;
}

export function kpiText(kpi: KPI, units: UnitPreferences = US, style: DisplayStyle = US_STYLE): KpiText {
  const title = titleOf(kpi, units);
  const value = valueOf(kpi, units, style);
  const detail = kpi.detail === null ? null : detailOf(kpi.detail, units, style);
  const parts = [title, value ?? 'no data yet'];
  if (detail !== null) parts.push(detail);
  return { title, value, detail, label: parts.join(', ') };
}

function titleOf(kpi: KPI, units: UnitPreferences): string {
  const economySpec = economyUnits[units.economy];
  const distanceSpec = distanceUnits[units.distance];
  const volumeSpec = volumeUnits[units.volume];
  switch (kpi.id) {
    case 'avgEconomy':
      return `Avg ${economySpec.abbreviation}`;
    case 'lastEconomy':
      return `Last ${economySpec.abbreviation}`;
    case 'totalSpent':
      return 'Total Spent';
    case 'costPerDistance':
      return `Cost per ${distanceSpec.singularNoun}`;
    case 'avgPrice':
      return `Avg Price/${volumeSpec.abbreviation}`;
    case 'distanceTracked':
      return `${distanceSpec.name} Tracked`;
    case 'fillUps':
      return 'Fill-Ups';
    case 'totalVolume':
      return `Total ${volumeSpec.name}`;
  }
}

function valueOf(kpi: KPI, units: UnitPreferences, style: DisplayStyle): string | null {
  const { value } = kpi;
  if (value === null) return null;
  const { locale } = style;
  switch (kpi.id) {
    case 'avgEconomy':
    case 'lastEconomy':
      return economy(value, units.economy, locale);
    case 'totalSpent':
      return currency(value, style);
    case 'costPerDistance':
      return costPerDistance(value, units.distance, style);
    case 'avgPrice':
      return fuelPrice(value, units.volume, style);
    case 'distanceTracked':
      return distance(value, units.distance, false, locale);
    case 'fillUps':
      // A plain count, as it always was: no grouping, so "1000" stays "1000".
      return String(value);
    case 'totalVolume':
      return volume(value, units.volume, false, locale);
  }
}

function detailOf(detail: KpiDetail, units: UnitPreferences, style: DisplayStyle): string {
  const { locale } = style;
  switch (detail.kind) {
    case 'bestEconomy':
      return `Best: ${economy(detail.mpg, units.economy, locale) ?? '—'}`;
    case 'monthlySpend':
      return `${currency(detail.amount, style)}/mo avg`;
    case 'lastPrice':
      return `Last: ${fuelPrice(detail.pricePerGallon, units.volume, style)}`;
    case 'milesPerFill':
      return `${distance(detail.miles, units.distance, false, locale)} ${distanceUnits[units.distance].abbreviation}/fill avg`;
    case 'gallonsPerFill':
      return `${volume(detail.gallons, units.volume, false, locale)} ${volumeUnits[units.volume].abbreviation} avg`;
    case 'costPerFill':
      return `${currency(detail.amount, style)}/fill avg`;
  }
}
