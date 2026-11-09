import type { ReactElement } from 'react';
import { datetimeLocalValue } from '../domain/fillUpForm';
import { FUEL_GRADES } from '../domain/fuelGrade';
import type { FuelGrade } from '../domain/fuelGrade';
import { currency, distance as formatDistance } from '../domain/format';
import type { UnitPreferences } from '../domain/units';
import { distance, pricePerGallonFrom, volume } from '../domain/units';
import type { FillUpRecord, FillUpSummary } from '../data/records';
import { TEXT_LIMITS } from '../domain/textLimits';
import type { FuelEntryDraft } from '../domain/fuelEntryDraft';
import { LINK_TEXT_LIMITS } from '../data/fillUpLink';
import { useFillUpForm } from './useFillUpForm';
import { ReceiptScanField } from './ReceiptScanField';
import { DecimalField } from './DecimalField';

interface Props {
  readonly vehicleId: string;
  readonly units: UnitPreferences;
  /** Existing fill-ups on this vehicle, for the odometer sanity check. */
  /** Only odometers are read from these, so summaries are enough. */
  readonly existing: readonly FillUpSummary[];
  /** The record being edited, or null when creating. */
  readonly editing: FillUpRecord | null;
  readonly onSaved: () => Promise<void>;
  readonly onCancel: () => void;
  /**
   * Filling in a fill-up for someone else's car, to send back by link (#3):
   * the draft goes to `onDraft` and nothing is written here. A link carries
   * text only and nothing about the owner's log, so there is no photo, no
   * "missed the previous fill-up", and no odometer check against a history
   * this reader cannot see; text is held to the link's limits as it is typed
   * rather than shortened unseen on the way out.
   */
  readonly forLink?: {
    readonly title: string;
    readonly onDraft: (draft: FuelEntryDraft) => Promise<void>;
  };
}

/**
 * The fill-up form.
 *
 * ## Units convert at the boundary, and only here
 *
 * State is held in canonical miles, US gallons and price-per-gallon. Each field
 * converts on the way out and back on the way in, so a reader typing litres
 * still stores gallons and every statistic is computed on one consistent set of
 * numbers. This is the mirror of the chart rule: convert the value, never
 * relabel it.
 *
 * ## Photos fill blanks; they never overwrite
 *
 * A receipt photo can be attached and read (`importReceipt.ts`): its gallons,
 * price, date and station go into fields that are still empty, and only when
 * the numbers corroborate each other. Manual entry stays the complete path —
 * scanning saves typing, it is never required. There is no live camera or pump
 * scanning; `docs/port.md` says why.
 */
export function FillUpForm({
  vehicleId,
  units,
  existing,
  editing,
  onSaved,
  onCancel,
  forLink,
}: Props): ReactElement {
  const {
    form,
    numericText,
    update,
    typeNumber,
    pickDate,
    importPhoto,
    save,
    scanning,
    scanNote,
    saveProblem,
    previous,
    odometerWarning,
    jump,
    total,
    canSave,
  } = useFillUpForm({ vehicleId, units, existing, editing, onSaved, onDraft: forLink?.onDraft });
  const volumeSpec = volume[units.volume];
  const distanceSpec = distance[units.distance];

  return (
    <form
      className="card"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      aria-labelledby="fillup-form-heading"
    >
      <h2 className="card__title" id="fillup-form-heading">
        {forLink?.title ?? (editing === null ? 'New fill-up' : 'Edit fill-up')}
      </h2>

      {forLink === undefined && (
        <ReceiptScanField scanning={scanning} note={scanNote} onFile={(file) => void importPhoto(file)} />
      )}

      <div className="field">
        <label className="field__label" htmlFor="fillup-date">
          Date
        </label>
        <input
          id="fillup-date"
          type="datetime-local"
          value={datetimeLocalValue(form.date)}
          onChange={(event) => {
            const parsed = new Date(event.target.value);
            if (!Number.isNaN(parsed.getTime())) pickDate(parsed);
          }}
        />
      </div>

      <DecimalField
        id="fillup-odometer"
        label={`Odometer (${distanceSpec.abbreviation})`}
        value={numericText.odometer}
        onChange={(text) => typeNumber('odometer', text, distanceSpec.toMiles)}
        describedBy={odometerWarning ? 'odometer-warning' : jump !== null ? 'odometer-gap-warning' : undefined}
      />

      {odometerWarning && previous !== null && (
        // A warning, not a block: this is usually a typo, but it can be a
        // replaced cluster or a correction, and the app cannot tell which.
        <p className="warning" id="odometer-warning" role="status">
          That is at or below the last reading (
          {formatDistance(previous, units.distance, true)}). Double-check before saving.
        </p>
      )}

      {jump !== null && (
        // A hint, not a block: a long trip between fill-ups is real. But one
        // that nobody logged — easy when two people share a car — stretches
        // the next MPG over two tanks, and this is the box that prevents it.
        <p className="warning" id="odometer-gap-warning" role="status">
          That is {formatDistance(jump.distance, units.distance, true)} since the last fill-up — more
          than twice the usual {formatDistance(jump.usual, units.distance, true)}. If a fill-up was not
          logged, tick &ldquo;Missed logging a fill before this one&rdquo; so the economy is not
          stretched across two tanks.
        </p>
      )}

      <DecimalField
        id="fillup-volume"
        label={volumeSpec.name}
        value={numericText.gallons}
        onChange={(text) => typeNumber('gallons', text, volumeSpec.toGallons)}
      />

      <DecimalField
        id="fillup-price"
        label={`Price per ${volumeSpec.singularNoun}`}
        value={numericText.price}
        onChange={(text) => typeNumber('price', text, (typed) => pricePerGallonFrom(typed, units.volume))}
      />

      <p className="stack">
        <span className="field__label">Total cost </span>
        <strong style={{ color: total > 0 ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
          {currency(total)}
        </strong>
      </p>

      <div className="field field--inline">
        <input
          className="checkbox"
          id="fillup-full"
          type="checkbox"
          checked={form.isFullTank}
          onChange={(event) => update('isFullTank', event.target.checked)}
        />
        <label className="field__label" htmlFor="fillup-full">
          Filled the tank completely
        </label>
      </div>

      {forLink === undefined && (
        <div className="field field--inline">
          <input
            className="checkbox"
            id="fillup-missed"
            type="checkbox"
            checked={form.missedPreviousFillUp}
            onChange={(event) => update('missedPreviousFillUp', event.target.checked)}
          />
          <label className="field__label" htmlFor="fillup-missed">
            Missed logging a fill before this one
          </label>
        </div>
      )}

      <p className="note flush-top">
        Marking full tanks is what lets the app work out exact economy between
        fills. Leave it off for a partial fill — those gallons still count toward
        the next full tank. Marking a missed fill keeps an impossible-looking
        segment out of your stats while the fuel still counts toward spending.
      </p>

      <div className="field">
        <label className="field__label" htmlFor="fillup-grade">
          Fuel grade
        </label>
        <select
          id="fillup-grade"
          value={form.fuelGrade}
          onChange={(event) => update('fuelGrade', event.target.value as FuelGrade)}
        >
          {FUEL_GRADES.map((grade) => (
            <option key={grade} value={grade}>
              {grade}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="fillup-station">
          Gas station (optional)
        </label>
        <input
          id="fillup-station"
          maxLength={forLink === undefined ? TEXT_LIMITS.station : LINK_TEXT_LIMITS.station}
          value={form.station}
          onChange={(event) => update('station', event.target.value)}
        />
      </div>

      <div className="field">
        <label className="field__label" htmlFor="fillup-notes">
          Notes (optional)
        </label>
        <textarea
          id="fillup-notes"
          maxLength={forLink === undefined ? TEXT_LIMITS.notes : LINK_TEXT_LIMITS.notes}
          rows={2}
          value={form.notes}
          onChange={(event) => update('notes', event.target.value)}
        />
      </div>

      {saveProblem !== null && (
        <p className="warning" role="alert">
          {saveProblem}
        </p>
      )}

      <div className="row-actions">
        <button className="button" type="submit" disabled={!canSave}>
          {forLink !== undefined ? 'Create link' : editing === null ? 'Save fill-up' : 'Save changes'}
        </button>
        <button className="button button--secondary" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
