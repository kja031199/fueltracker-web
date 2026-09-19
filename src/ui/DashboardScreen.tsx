import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';
import type { FillUpRecord, VehicleRecord } from '../data/records';
import { toStats } from '../data/store';
import { computeFuelStatistics } from '../domain/fuelStatistics';
import { dashboardKPIs, kpiAccessibilityLabel } from '../domain/kpi';
import { hueFor } from '../domain/metric';
import { cutoffFrom, DASHBOARD_TIME_RANGES } from '../domain/dashboardTimeRange';
import type { DashboardTimeRange } from '../domain/dashboardTimeRange';
import {
  cheapestWeekday,
  weekdayPriceInsight,
  weekdayPrices,
} from '../domain/weekdayPricePattern';
import type { UnitPreferences } from '../domain/units';
import { distance as distanceUnits, economy as economyUnits, volume as volumeUnits } from '../domain/units';
import { currency, distance, fuelPrice } from '../domain/format';
import { mapValues } from '../domain/models';
import { MetricLineChart } from './charts/MetricLineChart';
import { MonthlyBarChart } from './charts/MonthlyBarChart';
import { WeekdayPriceChart } from './charts/WeekdayPriceChart';

interface Props {
  readonly vehicles: readonly VehicleRecord[];
  readonly selectedVehicleId: string | null;
  readonly onSelect: (id: string) => void;
  readonly fillUps: readonly FillUpRecord[];
  readonly units: UnitPreferences;
}

/**
 * The dashboard.
 *
 * ## The range picker narrows the view, not the maths it reports
 *
 * Statistics are recomputed over whatever the range admits, so "3M" genuinely
 * reports the last three months rather than a slice of an all-time figure. That
 * is different from the fill-up list's filter, which narrows only what is shown
 * while the dashboard keeps reading the full history — the two look similar and
 * mean different things.
 *
 * Charts are not here yet. The KPI cards and the weekday insight are the parts
 * that need no charting library, and the series work is a phase of its own.
 */
export function DashboardScreen({
  vehicles,
  selectedVehicleId,
  onSelect,
  fillUps,
  units,
}: Props): ReactElement {
  const [range, setRange] = useState<DashboardTimeRange>('All');

  const inRange = useMemo(() => {
    const cutoff = cutoffFrom(range);
    if (cutoff === null) return fillUps;
    return fillUps.filter((record) => record.date >= cutoff.getTime());
  }, [fillUps, range]);

  const stats = useMemo(() => computeFuelStatistics(toStats(inRange)), [inRange]);
  const kpis = useMemo(() => dashboardKPIs(stats, units), [stats, units]);
  const insight = useMemo(
    () => weekdayPriceInsight(toStats(inRange), { units }),
    [inRange, units],
  );

  const weekdays = useMemo(() => weekdayPrices(toStats(inRange)), [inRange]);
  const cheapest = useMemo(() => cheapestWeekday(toStats(inRange)), [inRange]);

  const economySpec = economyUnits[units.economy];
  const distanceSpec = distanceUnits[units.distance];
  const volumeSpec = volumeUnits[units.volume];

  /**
   * Economy is the one series that is **converted, not relabelled**.
   *
   * L/100km is the reciprocal of MPG, so the curve's shape genuinely changes
   * with the unit — a rising line becomes a falling one. Swapping the axis
   * label over the same points would draw the opposite of the truth. Price and
   * distance are linear, so those only need their labels changed.
   */
  const economySeries = useMemo(
    () => mapValues(stats.mpgSeries, (mpg) => economySpec.fromMPG(mpg) ?? 0),
    [stats.mpgSeries, economySpec],
  );
  const averageEconomy =
    stats.averageMPG === null ? null : economySpec.fromMPG(stats.averageMPG);

  if (selectedVehicleId === null) {
    return <p className="empty">Add a vehicle to see its numbers here.</p>;
  }

  return (
    <div>
      {vehicles.length > 1 && (
        <div className="field">
          <label className="field__label" htmlFor="dashboard-vehicle">
            Vehicle
          </label>
          <select
            id="dashboard-vehicle"
            value={selectedVehicleId}
            onChange={(event) => onSelect(event.target.value)}
          >
            {vehicles.map((vehicle) => (
              <option key={vehicle.id} value={vehicle.id}>
                {vehicle.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="field">
        <label className="field__label" htmlFor="dashboard-range">
          Time range
        </label>
        <select
          id="dashboard-range"
          value={range}
          onChange={(event) => setRange(event.target.value as DashboardTimeRange)}
        >
          {DASHBOARD_TIME_RANGES.map((option) => (
            <option key={option} value={option}>
              {option === 'All' ? 'All time' : option}
            </option>
          ))}
        </select>
      </div>

      {fillUps.length === 0 ? (
        <p className="empty">
          No fill-ups yet. Log one and your economy, spending and price trends show up here.
        </p>
      ) : (
        <>
          {insight !== null && (
            <p className="card" style={{ color: 'var(--accent-orange)' }}>
              {insight}
            </p>
          )}

          <ul
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
              gap: 'var(--gap)',
            }}
          >
            {kpis.map((kpi) => (
              // The card is labelled as one phrase rather than three separate
              // texts, so a screen reader reads a coherent stat instead of
              // "Avg MPG", "40.0", "Best: 42.0" as unrelated fragments.
              <li className="card" key={kpi.id} aria-label={kpiAccessibilityLabel(kpi)}>
                <span className="card__title" aria-hidden="true">
                  {kpi.title}
                </span>
                <div
                  aria-hidden="true"
                  style={{
                    fontSize: '1.5rem',
                    fontWeight: 700,
                    color: `var(--accent-${hueFor(kpi.metric)})`,
                  }}
                >
                  {kpi.value ?? '—'}
                </div>
                {kpi.detail !== null && (
                  <div
                    aria-hidden="true"
                    style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}
                  >
                    {kpi.detail}
                  </div>
                )}
              </li>
            ))}
          </ul>

          <MetricLineChart
            title={`Fuel economy (${economySpec.abbreviation})`}
            points={economySeries}
            metric="economy"
            unit={economySpec.abbreviation}
            formatValue={(value) => value.toFixed(1)}
            average={averageEconomy}
          />

          <MetricLineChart
            title={`Price per ${volumeSpec.singularNoun.toLowerCase()}`}
            points={stats.priceSeries}
            metric="price"
            unit={`per ${volumeSpec.abbreviation}`}
            formatValue={(value) => fuelPrice(value, units.volume)}
            average={stats.averagePricePerGallon}
          />

          <MetricLineChart
            title="Odometer"
            points={stats.odometerSeries}
            metric="distance"
            unit={distanceSpec.abbreviation}
            formatValue={(value) => distance(value, units.distance)}
          />

          <MonthlyBarChart
            title="Monthly spending"
            totals={stats.monthlyTotals}
            value={(total) => total.totalSpent}
            metric="spending"
            unit="spent"
            formatValue={(value) => currency(value)}
          />

          <MonthlyBarChart
            title={`Monthly ${distanceSpec.name.toLowerCase()}`}
            totals={stats.monthlyTotals}
            value={(total) => total.miles}
            metric="distance"
            unit={distanceSpec.abbreviation}
            formatValue={(value) => distance(value, units.distance)}
          />

          <WeekdayPriceChart
            prices={weekdays}
            cheapestWeekday={cheapest?.weekday ?? null}
            formatPrice={(value) => fuelPrice(value, units.volume)}
          />

          {stats.suspectSegmentIds.size > 0 && (
            <p className="warning" style={{ marginTop: 'var(--gap)' }}>
              {stats.suspectSegmentIds.size} fill-up
              {stats.suspectSegmentIds.size === 1 ? ' looks' : 's look'} like a fill-up went
              unlogged before {stats.suspectSegmentIds.size === 1 ? 'it' : 'them'} — the economy
              reads far higher than usual. Marking &ldquo;missed logging a fill&rdquo; on that entry
              keeps it out of your averages.
            </p>
          )}
        </>
      )}
    </div>
  );
}
