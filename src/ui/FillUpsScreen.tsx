import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';
import type { FillUpRecord } from '../data/records';
import type { FuelTrackerStore } from '../data/store';
import type { FillUpFilter } from '../domain/fillUpFilter';
import { EMPTY_FILTER, applyFilter, isFilterActive } from '../domain/fillUpFilter';
import { DASHBOARD_TIME_RANGES } from '../domain/dashboardTimeRange';
import type { DashboardTimeRange } from '../domain/dashboardTimeRange';
import { FUEL_GRADES } from '../domain/fuelGrade';
import type { FuelGrade } from '../domain/fuelGrade';
import { currency, distance as formatDistance, volume as formatVolume } from '../domain/format';
import type { UnitPreferences } from '../domain/units';
import { distance, volume } from '../domain/units';
import { FillUpForm } from './FillUpForm';

interface Props {
  readonly store: FuelTrackerStore;
  readonly vehicleId: string | null;
  readonly fillUps: readonly FillUpRecord[];
  readonly units: UnitPreferences;
  readonly onChanged: () => Promise<void>;
}

/**
 * The fill-up list, its search and filter, and the add/edit form.
 *
 * The filter is a **pure in-memory pass** over this vehicle's already-loaded
 * history, not a query. It narrows only what the list shows — every statistic
 * on the dashboard stays computed over the full history, so typing in the
 * search box can never change your reported MPG.
 */
export function FillUpsScreen({
  store,
  vehicleId,
  fillUps,
  units,
  onChanged,
}: Props): ReactElement {
  const [filter, setFilter] = useState<FillUpFilter>(EMPTY_FILTER);
  const [editing, setEditing] = useState<FillUpRecord | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const filterable = useMemo(
    () =>
      fillUps.map((record) => ({
        record,
        date: new Date(record.date),
        station: record.station,
        notes: record.notes,
        fuelGrade: record.fuelGrade,
      })),
    [fillUps],
  );

  const visible = useMemo(
    () => applyFilter(filter, filterable).map((entry) => entry.record),
    [filter, filterable],
  );

  if (vehicleId === null) {
    return <p className="empty">Add a vehicle first — fill-ups belong to one.</p>;
  }

  if (adding || editing !== null) {
    return (
      <FillUpForm
        store={store}
        vehicleId={vehicleId}
        units={units}
        existing={fillUps}
        editing={editing}
        onSaved={async () => {
          setAdding(false);
          setEditing(null);
          await onChanged();
        }}
        onCancel={() => {
          setAdding(false);
          setEditing(null);
        }}
      />
    );
  }

  async function remove(id: string): Promise<void> {
    await store.removeFillUp(id);
    setConfirmingId(null);
    await onChanged();
  }

  const stations = [...new Set(fillUps.map((r) => r.station).filter((s) => s !== ''))].sort();

  return (
    <div>
      <button className="button" type="button" onClick={() => setAdding(true)}>
        Log a fill-up
      </button>

      <section className="card" style={{ marginTop: 'var(--gap)' }} aria-labelledby="filter-heading">
        <h2 className="card__title" id="filter-heading">
          Search and filter
          {isFilterActive(filter) && (
            <span style={{ color: 'var(--accent-blue)' }}> · filters active</span>
          )}
        </h2>

        <div className="field">
          <label className="field__label" htmlFor="filter-search">
            Search station or notes
          </label>
          <input
            id="filter-search"
            type="search"
            value={filter.searchText}
            onChange={(event) => setFilter({ ...filter, searchText: event.target.value })}
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="filter-range">
            Time range
          </label>
          <select
            id="filter-range"
            value={filter.range}
            onChange={(event) =>
              setFilter({ ...filter, range: event.target.value as DashboardTimeRange })
            }
          >
            {DASHBOARD_TIME_RANGES.map((range) => (
              <option key={range} value={range}>
                {range === 'All' ? 'All time' : range}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="filter-grade">
            Fuel grade
          </label>
          <select
            id="filter-grade"
            value={filter.fuelGrade ?? ''}
            onChange={(event) =>
              setFilter({
                ...filter,
                fuelGrade: event.target.value === '' ? null : (event.target.value as FuelGrade),
              })
            }
          >
            <option value="">Any</option>
            {FUEL_GRADES.map((grade) => (
              <option key={grade} value={grade}>
                {grade}
              </option>
            ))}
          </select>
        </div>

        {stations.length > 0 && (
          <div className="field">
            <label className="field__label" htmlFor="filter-station">
              Station
            </label>
            <select
              id="filter-station"
              value={filter.station ?? ''}
              onChange={(event) =>
                setFilter({
                  ...filter,
                  station: event.target.value === '' ? null : event.target.value,
                })
              }
            >
              <option value="">Any</option>
              {stations.map((station) => (
                <option key={station} value={station}>
                  {station}
                </option>
              ))}
            </select>
          </div>
        )}

        {isFilterActive(filter) && (
          <button
            className="button button--secondary"
            type="button"
            onClick={() => setFilter(EMPTY_FILTER)}
          >
            Clear filters
          </button>
        )}
      </section>

      <section aria-labelledby="fillups-heading">
        <h2 className="card__title" id="fillups-heading">
          {visible.length} of {fillUps.length} fill-ups
        </h2>

        {fillUps.length === 0 ? (
          <p className="empty">No fill-ups yet. Log one to start tracking economy and cost.</p>
        ) : visible.length === 0 ? (
          <p className="empty">Nothing matches those filters.</p>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {visible.map((record) => (
              <li className="card" key={record.id}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <div>
                    <strong>{new Date(record.date).toLocaleDateString()}</strong>
                    {record.station !== '' && (
                      <span style={{ color: 'var(--text-secondary)' }}> · {record.station}</span>
                    )}
                    <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                      {formatVolume(record.gallons, units.volume, true)} ·{' '}
                      {formatDistance(record.odometer, units.distance, true)} ·{' '}
                      {record.fuelGrade}
                      {!record.isFullTank && ' · partial fill'}
                      {record.missedPreviousFillUp && ' · missed previous'}
                    </div>
                    {record.notes !== '' && (
                      <div style={{ fontSize: '0.9rem' }}>{record.notes}</div>
                    )}
                  </div>
                  <strong>{currency(record.gallons * record.pricePerGallon)}</strong>
                </div>
                <div className="row-actions" style={{ marginTop: 10 }}>
                  <button
                    className="button button--secondary"
                    type="button"
                    onClick={() => setEditing(record)}
                  >
                    Edit
                  </button>
                  {confirmingId === record.id ? (
                    <>
                      <button
                        className="button button--danger"
                        type="button"
                        onClick={() => void remove(record.id)}
                      >
                        Delete this fill-up
                      </button>
                      <button
                        className="button button--secondary"
                        type="button"
                        onClick={() => setConfirmingId(null)}
                      >
                        Keep
                      </button>
                    </>
                  ) : (
                    <button
                      className="button button--danger"
                      type="button"
                      onClick={() => setConfirmingId(record.id)}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
