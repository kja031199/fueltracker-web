import type { ReactElement } from 'react';
import { useMemo, useRef, useState } from 'react';
import type { FillUpFormState } from '../domain/fillUpForm';
import {
  canSaveForm,
  draftFromForm,
  editableText,
  emptyFillUpForm,
  formTotalCost,
  odometerLooksWrong,
  parseTypedNumber,
  previousOdometer,
} from '../domain/fillUpForm';
import { formFromRecord } from '../data/recordMapping';
import { FUEL_GRADES } from '../domain/fuelGrade';
import type { FuelGrade } from '../domain/fuelGrade';
import { currency, distance as formatDistance } from '../domain/format';
import type { UnitPreferences } from '../domain/units';
import { distance, pricePerGallonFrom, pricePerUnit, volume } from '../domain/units';
import type { FillUpRecord, FillUpSummary } from '../data/records';
import { useFuelLog } from './fuelLog';
import { importReceiptPhoto } from './importReceipt';
import { TEXT_LIMITS } from '../domain/textLimits';
import type { FuelEntryDraft } from '../domain/fuelEntryDraft';
import { LINK_TEXT_LIMITS } from '../data/fillUpLink';
import { StaleEdit } from '../data/staleEdit';
import { jumpFrom, odometerHistory } from '../domain/odometerGap';

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
  // Saving goes through the fuel log, which refreshes and syncs (#56).
  const { addFillUp, updateFillUp } = useFuelLog();
  const [form, setForm] = useState<FillUpFormState>(() =>
    editing === null ? emptyFillUpForm() : formFromRecord(editing),
  );
  const [saving, setSaving] = useState(false);
  // Why the last save did not go through, kept on screen with what was typed.
  const [saveProblem, setSaveProblem] = useState<string | null>(null);
  const [touchedDate, setTouchedDate] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState<string | null>(null);
  const photoInput = useRef<HTMLInputElement>(null);

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
    odometer: editableText(
      editing === null ? null : editing.odometer,
      distance[units.distance].fromMiles,
    ),
    gallons: editableText(
      editing === null ? null : editing.gallons,
      volume[units.volume].fromGallons,
    ),
    price: editableText(
      editing === null ? null : editing.pricePerGallon,
      (canonical) => pricePerUnit(canonical, units.volume),
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
    const typed = parseTypedNumber(text);
    const canonical = typed === null ? null : toCanonical(typed);
    if (field === 'odometer') update('odometer', canonical);
    else if (field === 'gallons') update('gallons', canonical);
    else update('pricePerGallon', canonical);
  }

  // The car's other readings, sorted once per history rather than on every
  // keystroke (#88): only the typed reading changes as somebody types.
  const editingId = editing?.id;
  const history = useMemo(
    () => odometerHistory(existing.filter((record) => record.id !== editingId).map((record) => record.odometer)),
    [existing, editingId],
  );
  const previous = previousOdometer(
    existing.map((record) => record.odometer),
    editing !== null,
  );
  const odometerWarning = odometerLooksWrong(form.odometer, previous);
  // "Did somebody forget to log a fill-up?" (#66) — measured against the
  // car's other readings, never this entry's own, and only until the missed
  // box is ticked: once it is, the hint has done its job.
  const jump = odometerWarning || form.missedPreviousFillUp ? null : jumpFrom(history, form.odometer);
  const total = formTotalCost(form);
  const canSave = canSaveForm(form) && !saving;

  /**
   * Applies a scan **into blanks only**.
   *
   * What someone typed outranks what a camera guessed. A scanner that
   * overwrites a hand-entered price is worse than one that does nothing,
   * because the correction is invisible — the field just quietly holds a
   * different number than the person put there.
   */
  async function importPhoto(file: File): Promise<void> {
    setScanning(true);
    setScanNote(null);
    try {
      const outcome = await importReceiptPhoto(file);
      if (!outcome.ok) {
        setScanNote(outcome.message);
        return;
      }
      const { suggestion } = outcome;

      setForm((current) => ({
        ...current,
        gallons: current.gallons ?? suggestion.gallons,
        pricePerGallon: current.pricePerGallon ?? suggestion.pricePerGallon,
        station: current.station === '' ? (suggestion.station ?? '') : current.station,
        receiptImageData: suggestion.receiptImageData,
        ...(suggestion.date !== null && !touchedDate ? { date: suggestion.date } : {}),
      }));

      setNumericText((current) => ({
        ...current,
        gallons:
          current.gallons === '' && suggestion.gallons !== null
            ? editableText(suggestion.gallons, volumeSpec.fromGallons)
            : current.gallons,
        price:
          current.price === '' && suggestion.pricePerGallon !== null
            ? editableText(
                suggestion.pricePerGallon,
                (canonical) => pricePerUnit(canonical, units.volume),
              )
            : current.price,
      }));

      setScanNote(suggestion.note);
    } finally {
      setScanning(false);
    }
  }

  async function save(): Promise<void> {
    const draft = draftFromForm(form);
    if (draft === null) return;
    setSaving(true);
    setSaveProblem(null);
    try {
      if (forLink !== undefined) await forLink.onDraft(draft);
      else if (editing === null) await addFillUp(draft, vehicleId);
      // On the fill-up's own car, never the selected one (#83).
      else await updateFillUp(editing.id, draft);
      await onSaved();
    } catch (cause) {
      // The form stays open with what was typed: a refusal is said, not
      // swallowed, and the reader decides what to do with their changes.
      setSaveProblem(
        cause instanceof StaleEdit ? cause.message : 'That could not be saved. Your changes are still here; try again.',
      );
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
        {forLink?.title ?? (editing === null ? 'New fill-up' : 'Edit fill-up')}
      </h2>

      {forLink === undefined && (
        <div className="field">
          <button
            className="button button--secondary"
            type="button"
            onClick={() => photoInput.current?.click()}
            disabled={scanning}
          >
            {scanning ? 'Reading the photo…' : 'Fill in from a receipt photo'}
          </button>
          <input
            ref={photoInput}
            type="file"
            accept="image/*"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file !== undefined) void importPhoto(file);
            }}
          />
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', margin: 0 }}>
            Photograph a paper receipt and the gallons, price, date and station are filled in for
            you — into empty fields only, so nothing you typed is overwritten. Pump displays are not
            supported; their segment digits are not readable by this. Needs a connection the first
            time.
          </p>
          {scanNote !== null && (
            <p className="warning" role="status" style={{ marginTop: 6 }}>
              {scanNote}
            </p>
          )}
        </div>
      )}

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
            if (!Number.isNaN(parsed.getTime())) {
              setTouchedDate(true);
              update('date', parsed);
            }
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
          aria-describedby={
            odometerWarning ? 'odometer-warning' : jump !== null ? 'odometer-gap-warning' : undefined
          }
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
            typeNumber('price', event.target.value, (typed) => pricePerGallonFrom(typed, units.volume))
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

      {forLink === undefined && (
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
      )}

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
