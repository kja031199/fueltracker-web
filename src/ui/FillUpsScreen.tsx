import type { ReactElement } from 'react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { FillUpRecord } from '../data/records';
import type { FillUpFilter } from '../domain/fillUpFilter';
import { EMPTY_FILTER, applyFilter, isFilterActive } from '../domain/fillUpFilter';
import { DASHBOARD_TIME_RANGES } from '../domain/dashboardTimeRange';
import type { DashboardTimeRange } from '../domain/dashboardTimeRange';
import { FUEL_GRADES } from '../domain/fuelGrade';
import type { FuelGrade } from '../domain/fuelGrade';
import { formatDate } from '../domain/format';
import { fillUpFacts, fillUpName } from './wording';
import { gradeLabel, rangeLabel } from './words';
import { totalCost } from '../domain/models';
import { FillUpForm } from './FillUpForm';
import { useFuelLog } from './fuelLog';
import { PendingReview } from './PendingReview';
import { FillUpSummary } from './FillUpSummary';
import { ConfirmButton } from './ConfirmButton';
import { useDisplay, useUnits } from './session';
import { useEnteredByNames } from './useEnteredByNames';

/**
 * The fill-up list, its search and filter, and the add/edit form.
 *
 * The filter is a **pure in-memory pass** over this vehicle's already-loaded
 * history, not a query. It narrows only what the list shows — every statistic
 * on the dashboard stays computed over the full history, so typing in the
 * search box can never change your reported MPG.
 */
export function FillUpsScreen(): ReactElement {
  // One base per rendering, so a component shown twice never repeats an id (#95).
  const idBase = useId();
  const { units } = useUnits();
  const { locale } = useDisplay().style;
  // The selected vehicle's history, and the writes, from the fuel log (#56).
  const { selectedVehicleId: vehicleId, fillUps, loadFillUp, removeFillUp } = useFuelLog();
  const enteredByName = useEnteredByNames(vehicleId);
  const [filter, setFilter] = useState<FillUpFilter>(EMPTY_FILTER);
  // The **whole** row, photo included — never a list row (#53). The form saves
  // whatever it was given, so starting it from a summary would save the
  // fill-up back without its photo. The type makes that impossible to write.
  const [editing, setEditing] = useState<FillUpRecord | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  // Closing the form puts focus on the list it returns to (#95), not on
  // <body>: the button that opened it is gone with the form. Opening it is
  // the form's own job (`focusHeading`).
  const formOpen = adding || editing !== null;
  const listHeading = useRef<HTMLHeadingElement>(null);
  const shownOpen = useRef(formOpen);
  useEffect(() => {
    if (shownOpen.current === formOpen) return;
    shownOpen.current = formOpen;
    if (!formOpen) listHeading.current?.focus();
  }, [formOpen]);

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

  // Worked out once per list, not per render (#88).
  const stations = useMemo(
    () => [...new Set(fillUps.map((r) => r.station).filter((s) => s !== ''))].sort(),
    [fillUps],
  );

  if (vehicleId === null) {
    return (
      <div>
        <PendingReview />
        <p className="empty">Add a vehicle first — fill-ups belong to one.</p>
      </div>
    );
  }

  if (adding || editing !== null) {
    return (
      <FillUpForm
        vehicleId={vehicleId}
        focusHeading
        existing={fillUps}
        editing={editing}
        onSaved={async () => {
          setAdding(false);
          setEditing(null);
        }}
        onCancel={() => {
          setAdding(false);
          setEditing(null);
        }}
      />
    );
  }

  async function edit(id: string): Promise<void> {
    // Gone since the list was drawn (deleted on another device and synced):
    // `loadFillUp` refreshes the list rather than open a form for nothing.
    const whole = await loadFillUp(id);
    if (whole !== undefined) setEditing(whole);
  }

  async function remove(id: string): Promise<void> {
    await removeFillUp(id);
    setConfirmingId(null);
  }


  return (
    <div>
      <PendingReview />
      <button className="button" type="button" onClick={() => setAdding(true)}>
        Log a fill-up
      </button>

      <section className="card space-above" aria-labelledby={`${idBase}-filter-heading`}>
        <h2 className="card__title" id={`${idBase}-filter-heading`}>
          Search and filter
          {isFilterActive(filter) && (
            <span className="accent-blue"> · filters active</span>
          )}
        </h2>

        <div className="field">
          <label className="field__label" htmlFor={`${idBase}-filter-search`}>
            Search station or notes
          </label>
          <input
            id={`${idBase}-filter-search`}
            type="search"
            value={filter.searchText}
            onChange={(event) => setFilter({ ...filter, searchText: event.target.value })}
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor={`${idBase}-filter-range`}>
            Time range
          </label>
          <select
            id={`${idBase}-filter-range`}
            value={filter.range}
            onChange={(event) =>
              setFilter({ ...filter, range: event.target.value as DashboardTimeRange })
            }
          >
            {DASHBOARD_TIME_RANGES.map((range) => (
              <option key={range} value={range}>
                {rangeLabel(range)}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="field__label" htmlFor={`${idBase}-filter-grade`}>
            Fuel grade
          </label>
          <select
            id={`${idBase}-filter-grade`}
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
                {gradeLabel(grade)}
              </option>
            ))}
          </select>
        </div>

        {stations.length > 0 && (
          <div className="field">
            <label className="field__label" htmlFor={`${idBase}-filter-station`}>
              Station
            </label>
            <select
              id={`${idBase}-filter-station`}
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

      <section aria-labelledby={`${idBase}-fillups-heading`}>
        <h2 className="card__title" id={`${idBase}-fillups-heading`} ref={listHeading} tabIndex={-1}>
          {visible.length} of {fillUps.length} fill-ups
        </h2>

        {fillUps.length === 0 ? (
          <p className="empty">No fill-ups yet. Log one to start tracking economy and cost.</p>
        ) : visible.length === 0 ? (
          <p className="empty">Nothing matches those filters.</p>
        ) : (
          <ul className="list-plain">
            {visible.map((record) => (
              <li className="card" key={record.id}>
                <FillUpSummary
                  title={formatDate(record.date, locale)}
                  subtitle={record.station}
                  facts={fillUpFacts(record, units, { missed: true, locale })}
                  notes={record.notes}
                  cost={totalCost(record)}
                >
                  {enteredByName !== null && record.enteredBy != null && enteredByName.has(record.enteredBy) && (
                    <div className="note">
                      Entered by {enteredByName.get(record.enteredBy)}
                    </div>
                  )}
                </FillUpSummary>
                <div className="row-actions space-above-sm">
                  <button
                    className="button button--secondary"
                    type="button"
                    onClick={() => void edit(record.id)}
                    aria-label={`Edit ${fillUpName(record, units, locale)}`}
                  >
                    Edit
                  </button>
                  <ConfirmButton
                    asking={confirmingId === record.id}
                    onAsk={() => setConfirmingId(record.id)}
                    onCancel={() => setConfirmingId(null)}
                    onConfirm={() => void remove(record.id)}
                    label="Delete"
                    confirmLabel="Delete this fill-up"
                    cancelLabel="Keep"
                    labelSuffix={fillUpName(record, units, locale)}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
