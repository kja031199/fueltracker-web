/**
 * The fill-up form's state and what it does (#93): typing, reading a receipt,
 * saving. Moved out of `FillUpForm.tsx`, which is now its layout.
 */

import { useMemo, useState } from 'react';
import type { FillUpFormState } from '../domain/fillUpForm';
import {
  applyScan,
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
import type { UnitPreferences } from '../domain/units';
import { distance, pricePerUnit, volume } from '../domain/units';
import type { FillUpRecord, FillUpSummary } from '../data/records';
import type { FuelEntryDraft } from '../domain/fuelEntryDraft';
import { StaleEdit } from '../data/staleEdit';
import { jumpFrom, odometerHistory } from '../domain/odometerGap';
import { useFuelLog } from './fuelLog';
import { importReceiptPhoto } from './importReceipt';

/** The three fields typed as numbers. */
export type NumericField = 'odometer' | 'gallons' | 'price';

export function useFillUpForm({
  vehicleId,
  units,
  existing,
  editing,
  onSaved,
  onDraft,
}: {
  readonly vehicleId: string;
  readonly units: UnitPreferences;
  readonly existing: readonly FillUpSummary[];
  readonly editing: FillUpRecord | null;
  readonly onSaved: () => Promise<void>;
  /** For a fill-up sent back by link (#3): the draft goes here, and nothing is written. */
  readonly onDraft?: ((draft: FuelEntryDraft) => Promise<void>) | undefined;
}) {
  // Saving goes through the fuel log, which refreshes and syncs (#56).
  const { addFillUp, updateFillUp } = useFuelLog();
  const [form, setForm] = useState<FillUpFormState>(() =>
    editing === null ? emptyFillUpForm() : formFromRecord(editing),
  );
  const [saving, setSaving] = useState(false);
  // Why the last save did not go through, kept on screen with what was typed.
  const [saveProblem, setSaveProblem] = useState<string | null>(null);
  const [dateTouched, setDateTouched] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState<string | null>(null);

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
  const [numericText, setNumericText] = useState<Record<NumericField, string>>(() => ({
    odometer: editableText(editing === null ? null : editing.odometer, distance[units.distance].fromMiles),
    gallons: editableText(editing === null ? null : editing.gallons, volume[units.volume].fromGallons),
    price: editableText(editing === null ? null : editing.pricePerGallon, (canonical) =>
      pricePerUnit(canonical, units.volume),
    ),
  }));

  const update = <K extends keyof FillUpFormState>(key: K, value: FillUpFormState[K]): void => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  /** Records what was typed, and the canonical value it means. */
  function typeNumber(field: NumericField, text: string, toCanonical: (displayed: number) => number): void {
    setNumericText((current) => ({ ...current, [field]: text }));
    const typed = parseTypedNumber(text);
    const canonical = typed === null ? null : toCanonical(typed);
    if (field === 'odometer') update('odometer', canonical);
    else if (field === 'gallons') update('gallons', canonical);
    else update('pricePerGallon', canonical);
  }

  /** A date picked by hand, which a receipt's date will not then replace. */
  function pickDate(date: Date): void {
    setDateTouched(true);
    update('date', date);
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

  /** Reads a receipt photo into the form's blanks (`applyScan`), and its text into the empty fields. */
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
      setForm((current) => applyScan(current, suggestion, { dateTouched }));
      setNumericText((current) => ({
        ...current,
        gallons:
          current.gallons === '' && suggestion.gallons !== null
            ? editableText(suggestion.gallons, volume[units.volume].fromGallons)
            : current.gallons,
        price:
          current.price === '' && suggestion.pricePerGallon !== null
            ? editableText(suggestion.pricePerGallon, (canonical) => pricePerUnit(canonical, units.volume))
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
      if (onDraft !== undefined) await onDraft(draft);
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

  return {
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
  };
}
