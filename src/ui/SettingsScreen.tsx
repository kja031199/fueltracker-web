import type { ReactElement } from 'react';
import { useRef, useState } from 'react';
import type { UnitPreferences } from '../domain/units';
import type { FuelTrackerStore } from '../data/store';
import { backupFilename } from '../data/backup';
import { parseCsv, parseJsonBackup, toCsv, toJsonBackup } from '../domain/backupFormat';
import { downloadText } from './download';
import {
  DISTANCE_UNITS,
  ECONOMY_UNITS,
  VOLUME_UNITS,
  distance,
  economy,
  volume,
} from '../domain/units';

interface Props {
  readonly units: UnitPreferences;
  readonly onChange: (units: UnitPreferences) => void;
  readonly store: FuelTrackerStore;
  readonly onImported: () => Promise<void>;
}

/**
 * Units, and the honest note about where the data lives.
 *
 * Changing a unit changes only what is shown and what typed numbers are read
 * as; every stored value stays canonical, so nothing is rewritten and nothing
 * can be lost in a conversion.
 */
export function SettingsScreen({ units, onChange, store, onImported }: Props): ReactElement {
  const fileInput = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [problems, setProblems] = useState<readonly string[]>([]);

  async function exportJson(): Promise<void> {
    const snapshot = await store.exportSnapshot();
    downloadText(toJsonBackup(snapshot), backupFilename(), 'application/json');
    setProblems([]);
    setStatus(
      `Saved a backup of ${snapshot.vehicles.length} vehicle(s) and ${snapshot.fillUps.length} fill-up(s).`,
    );
  }

  async function exportCsv(): Promise<void> {
    const snapshot = await store.exportSnapshot();
    // Tombstones are a backup concern, not a spreadsheet one — a deleted
    // fill-up is not a row anybody wants in their expenses.
    const live = snapshot.fillUps.filter((record) => record.deletedAt === null);
    downloadText(toCsv(live), backupFilename(new Date(), 'csv'), 'text/csv');
    setProblems([]);
    setStatus(`Saved ${live.length} fill-up(s) as CSV.`);
  }

  async function importFile(file: File): Promise<void> {
    const text = await file.text();
    const isCsv = file.name.toLowerCase().endsWith('.csv');
    const parsed = isCsv ? parseCsv(text) : parseJsonBackup(text);

    if (parsed.value === null) {
      setStatus(null);
      setProblems([parsed.error ?? 'That file could not be read.']);
      return;
    }

    const snapshot = isCsv
      ? { vehicles: [], fillUps: parsed.value as never[], pendingFillUps: [] }
      : (parsed.value as Awaited<ReturnType<FuelTrackerStore['exportSnapshot']>>);
    const summary = await store.importBackup(snapshot);
    await onImported();

    setStatus(
      `Imported ${summary.fillUpsWritten} fill-up(s) and ${summary.vehiclesWritten} vehicle(s). ` +
        `${summary.skippedOlder} row(s) were already up to date.`,
    );
    setProblems([...parsed.skipped, ...summary.rejected]);
  }

  return (
    <div>
      <section className="card" aria-labelledby="units-heading">
        <h2 className="card__title" id="units-heading">
          Units
        </h2>

        <div className="field">
          <label className="field__label" htmlFor="unit-volume">
            Volume
          </label>
          <select
            id="unit-volume"
            value={units.volume}
            onChange={(e) =>
              onChange({ ...units, volume: e.target.value as UnitPreferences['volume'] })
            }
          >
            {VOLUME_UNITS.map((unit) => (
              <option key={unit} value={unit}>
                {volume[unit].name}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="unit-distance">
            Distance
          </label>
          <select
            id="unit-distance"
            value={units.distance}
            onChange={(e) =>
              onChange({ ...units, distance: e.target.value as UnitPreferences['distance'] })
            }
          >
            {DISTANCE_UNITS.map((unit) => (
              <option key={unit} value={unit}>
                {distance[unit].name}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="unit-economy">
            Fuel economy
          </label>
          <select
            id="unit-economy"
            value={units.economy}
            onChange={(e) =>
              onChange({ ...units, economy: e.target.value as UnitPreferences['economy'] })
            }
          >
            {ECONOMY_UNITS.map((unit) => (
              <option key={unit} value={unit}>
                {economy[unit].name}
              </option>
            ))}
          </select>
        </div>

        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', margin: 0 }}>
          Readings are stored in miles, US gallons and MPG whatever you pick here — changing a unit
          changes what you see and type, never what is saved.
        </p>
      </section>

      <section className="card" aria-labelledby="storage-heading">
        <h2 className="card__title" id="storage-heading">
          Where your data lives
        </h2>
        <p style={{ margin: '0 0 8px' }}>
          Everything is stored in this browser, on this device. There is no account and no server,
          so nothing is uploaded anywhere.
        </p>
        <p className="warning" style={{ margin: 0 }}>
          That also means clearing your browser data deletes your fuel log, and nobody can get it
          back for you. Export a backup now and again — it is the only copy there is.
        </p>
      </section>

      <section className="card" aria-labelledby="backup-heading">
        <h2 className="card__title" id="backup-heading">
          Backup and restore
        </h2>

        <div className="row-actions">
          <button className="button" type="button" onClick={() => void exportJson()}>
            Export backup (JSON)
          </button>
          <button className="button button--secondary" type="button" onClick={() => void exportCsv()}>
            Export spreadsheet (CSV)
          </button>
          <button
            className="button button--secondary"
            type="button"
            onClick={() => fileInput.current?.click()}
          >
            Import a file
          </button>
        </div>

        <input
          ref={fileInput}
          type="file"
          accept=".json,.csv,application/json,text/csv"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            // Reset first, so choosing the same file twice fires again.
            event.target.value = '';
            if (file !== undefined) void importFile(file);
          }}
        />

        {status !== null && (
          <p role="status" style={{ marginBottom: 0 }}>
            {status}
          </p>
        )}

        {problems.length > 0 && (
          <div className="warning" style={{ marginTop: 'var(--gap)' }}>
            <strong>{problems.length} row(s) could not be imported:</strong>
            <ul style={{ margin: '4px 0 0', paddingLeft: '1.2em' }}>
              {problems.slice(0, 10).map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
            {problems.length > 10 && <p style={{ margin: 0 }}>…and {problems.length - 10} more.</p>}
          </div>
        )}

        <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 0 }}>
          The JSON backup is the complete one — every vehicle, every fill-up, and the deletions
          too — and importing it merges rather than replaces, so restoring an old backup will not
          wipe out newer entries. The CSV is for spreadsheets: fill-ups only, in miles and US
          gallons whatever you have selected above, with the unit named in each column heading.
        </p>
      </section>
    </div>
  );
}
