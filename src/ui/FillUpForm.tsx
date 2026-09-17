import type { ReactElement } from 'react';
import { useState } from 'react';
import type { FillUpFormState } from '../domain/fillUpForm';
import {
  canSaveForm,
  draftFromForm,
  emptyFillUpForm,
  formTotalCost,
  odometerLooksWrong,
  previousOdometer,
} from '../domain/fillUpForm';
import { FUEL_GRADES } from '../domain/fuelGrade';
import type { FuelGrade } from '../domain/fuelGrade';
import { currency, distance as formatDistance } from '../domain/format';
import type { UnitPreferences } from '../domain/units';
import { distance, volume } from '../domain/units';
import type { FillUpRecord } from '../data/records';
import type { FuelTrackerStore } from '../data/store';

interface Props {
  readonly store: FuelTrackerStore;
  readonly vehicleId: string;
  readonly units: UnitPreferences;
  /** Existing fill-ups on this vehicle, for the odometer sanity check. */
  readonly existing: readonly FillUpRecord[];
  /** The record being edited, or null when creating. */
  readonly editing: FillUpRecord | null;
  readonly onSaved: () => Promise<void>;
  readonly onCancel: () => void;
}

/** A stored record read back into canonical form state. */
function formFrom(record: FillUpRecord): FillUpFormState {
  return {
    date: new Date(record.date),
    odometer: record.odometer,
    gallons: record.gallons,
    pricePerGallon: record.pricePerGallon,
    isFullTank: record.isFullTank,
    missedPreviousFillUp: record.missedPreviousFillUp,
    fuelGrade: record.fuelGrade,
    station: record.station,
    notes: record.notes,
    latitude: record.latitude,
    longitude: record.longitude,
    receiptImageData: record.receiptImageData,
  };
}

/**
 * Parses a typed number, treating blank and nonsense alike as "not entered".
 *
 * Returning `null` rather than `NaN` is what keeps the draft's validation the
 * only thing deciding whether a form can be saved — a `NaN` odometer would
 * otherwise have to be caught twice.
 */
function parseNumber(text: string): number | null {
  if (text.trim() === '') return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/**
 * A canonical value rendered as editable text.
 *
 * Only used to seed a field when editing an existing record — never to re-render
 * text the reader is in the middle of typing. See the note on `numericText`.
 */
function displayText(value: number | null, toDisplay: (canonical: number) => number): string {
  if (value === null) return '';
  // Conversion produces long tails (10 gal → 37.854117839999996); three
  // decimals is the precision a pump prints and what the entry boundary keeps.
  return String(Math.round(toDisplay(value) * 1000) / 1000);
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
 * ## What is deliberately missing
 *
 * No camera scanning and no photo import. The parsers for both are ported and
 * tested, but wiring them needs image intake and OCR, which is a later phase.
 * Manual entry is the complete path today.
 */
export function FillUpForm({
  store,
  vehicleId,
  units,
  existing,
  editing,
  onSaved,
  onCancel,
}: Props): ReactElement {
  const [form, setForm] = useState<FillUpFormState>(() =>
    editing === null ? emptyFillUpForm() : formFrom(editing),
  );
  const [saving, setSaving] = useState(false);

  const volumeSpec = volume[units.volume];
  const distanceSpec = distance[units.distance];

  /**
   * The three numeric fields keep their **raw text** alongside the parsed
   * value, and the input renders the text rather than the number.
   *
   * This is not redundancy. A controlled numeric input that re-renders
   * `String(Number(typed))` on every keystroke destroys a decimal as it is
   * being entered: typing "3.5" parses "3." to 3, renders "3", and the next
   * keystroke appends to that — producing 35, a price ten times too high,
   * silently. Keeping the text means what the reader typed is what stays on
   * screen, and the number is derived from it rather than the other way round.
   */
  const [numericText, setNumericText] = useState<{
    odometer: string;
    gallons: string;
    price: string;
  }>(() => ({
    odometer: displayText(
      editing === null ? null : editing.odometer,
      distance[units.distance].fromMiles,
    ),
    gallons: displayText(
      editing === null ? null : editing.gallons,
      volume[units.volume].fromGallons,
    ),
    price: displayText(
      editing === null ? null : editing.pricePerGallon,
      (canonical) => canonical / volume[units.volume].fromGallons(1),
    ),
  }));

  const update = <K extends keyof FillUpFormState>(key: K, value: FillUpFormState[K]): void => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  /** Records what was typed, and the canonical value it means. */
  function typeNumber(
    field: 'odometer' | 'gallons' | 'price',
    text: string,
    toCanonical: (displayed: number) => number,
  ): void {
    setNumericText((current) => ({ ...current, [field]: text }));
    const typed = parseNumber(text);
    const canonical = typed === null ? null : toCanonical(typed);
    if (field === 'odometer') update('odometer', canonical);
    else if (field === 'gallons') update('gallons', canonical);
    else update('pricePerGallon', canonical);
  }

  const previous = previousOdometer(
    existing.map((record) => record.odometer),
    editing !== null,
  );
  const odometerWarning = odometerLooksWrong(form.odometer, previous);
  const total = formTotalCost(form);
  const canSave = canSaveForm(form) && !saving;

  async function save(): Promise<void> {
    const draft = draftFromForm(form);
    if (draft === null) return;
    setSaving(true);
    try {
      if (editing === null) await store.addFillUp(draft, vehicleId);
      else await store.updateFillUp(editing.id, draft, vehicleId);
      await onSaved();
    } finally {
      setSaving(false);
    }
  }

  // `datetime-local` wants a local wall-clock string, not an ISO instant.
  const dateValue = (() => {
    const d = form.date;
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  })();

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
        {editing === null ? 'New fill-up' : 'Edit fill-up'}
      </h2>

      <div className="field">
        <label className="field__label" htmlFor="fillup-date">
          Date
        </label>
        <input
          id="fillup-date"
          type="datetime-local"
          value={dateValue}
          onChange={(event) => {
            const parsed = new Date(event.target.value);
            if (!Number.isNaN(parsed.getTime())) update('date', parsed);
          }}
        />
      </div>

      <div className="field">
        <label className="field__label" htmlFor="fillup-odometer">
          Odometer ({distanceSpec.abbreviation})
        </label>
        <input
          id="fillup-odometer"
          type="text"
          inputMode="decimal"
          value={numericText.odometer}
          onChange={(event) => typeNumber('odometer', event.target.value, distanceSpec.toMiles)}
          aria-describedby={odometerWarning ? 'odometer-warning' : undefined}
        />
      </div>

      {odometerWarning && previous !== null && (
        // A warning, not a block: this is usually a typo, but it can be a
        // replaced cluster or a correction, and the app cannot tell which.
        <p className="warning" id="odometer-warning" role="status">
          That is at or below the last reading (
          {formatDistance(previous, units.distance, true)}). Double-check before saving.
        </p>
      )}

      <div className="field">
        <label className="field__label" htmlFor="fillup-volume">
          {volumeSpec.name}
        </label>
        <input
          id="fillup-volume"
          type="text"
          inputMode="decimal"
          value={numericText.gallons}
          onChange={(event) => typeNumber('gallons', event.target.value, volumeSpec.toGallons)}
        />
      </div>

      <div className="field">
        <label className="field__label" htmlFor="fillup-price">
          Price per {volumeSpec.singularNoun}
        </label>
        <input
          id="fillup-price"
          type="text"
          inputMode="decimal"
          value={numericText.price}
          onChange={(event) =>
            typeNumber('price', event.target.value, (typed) => typed * volumeSpec.fromGallons(1))
          }
        />
      </div>

      <p style={{ margin: '0 0 var(--gap)' }}>
        <span className="field__label">Total cost </span>
        <strong style={{ color: total > 0 ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
          {currency(total)}
        </strong>
      </p>

      <div className="field field--inline">
        <input
          id="fillup-full"
          type="checkbox"
          checked={form.isFullTank}
          onChange={(event) => update('isFullTank', event.target.checked)}
          style={{ minHeight: 'auto', width: 20, height: 20 }}
        />
        <label className="field__label" htmlFor="fillup-full">
          Filled the tank completely
        </label>
      </div>

      <div className="field field--inline">
        <input
          id="fillup-missed"
          type="checkbox"
          checked={form.missedPreviousFillUp}
          onChange={(event) => update('missedPreviousFillUp', event.target.checked)}
          style={{ minHeight: 'auto', width: 20, height: 20 }}
        />
        <label className="field__label" htmlFor="fillup-missed">
          Missed logging a fill before this one
        </label>
      </div>

      <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: 0 }}>
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
          rows={2}
          value={form.notes}
          onChange={(event) => update('notes', event.target.value)}
        />
      </div>

      <div className="row-actions">
        <button className="button" type="submit" disabled={!canSave}>
          {editing === null ? 'Save fill-up' : 'Save changes'}
        </button>
        <button className="button button--secondary" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
