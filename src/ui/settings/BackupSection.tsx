import type { ReactElement } from 'react';
import { useId, useRef, useState } from 'react';
import { describeSince } from '../../domain/format';
import { useBackupStatus, useFuelLog } from '../fuelLog';

/**
 * Settings → Backup and restore. Backup, restore and sync all go through the
 * fuel log (#56): an import refreshes the screens and schedules a sync, and a
 * backup is recorded for the reminder (#93), without this section asking.
 */
export function BackupSection(): ReactElement {
  // One base per rendering, so a component shown twice never repeats an id (#95).
  const idBase = useId();
  const { saveBackup, exportCsv, importFile } = useFuelLog();
  const { lastBackupAt } = useBackupStatus();
  const fileInput = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [problems, setProblems] = useState<readonly string[]>([]);

  async function exportJson(): Promise<void> {
    const saved = await saveBackup();
    setProblems([]);
    setStatus(
      `Saved a backup of ${saved.vehicles} vehicle(s) and ${saved.fillUps} fill-up(s).`,
    );
  }

  async function exportSpreadsheet(): Promise<void> {
    const count = await exportCsv();
    setProblems([]);
    setStatus(`Saved ${count} fill-up(s) as CSV.`);
  }

  async function chooseFile(file: File): Promise<void> {
    const { summary, problems: found } = await importFile(file);
    setStatus(
      summary === null
        ? null
        : `Imported ${summary.fillUpsWritten} fill-up(s) and ${summary.vehiclesWritten} vehicle(s). ` +
            `${summary.skippedOlder} row(s) were already up to date.`,
    );
    setProblems(found);
  }

  return (
    <section className="card" aria-labelledby={`${idBase}-backup-heading`}>
      <h2 className="card__title" id={`${idBase}-backup-heading`}>
        Backup and restore
      </h2>

      <p className="stack-sm">
        Last backup: <strong>{describeSince(lastBackupAt)}</strong>.
      </p>
      <p className="stack muted">
        Only the JSON export counts as a backup. The CSV is fill-ups only — no vehicles, no
        deletions, no receipt photos — so it is for spreadsheets, not for restoring.
      </p>

      <div className="row-actions">
        <button className="button" type="button" onClick={() => void exportJson()}>
          Export backup (JSON)
        </button>
        <button className="button button--secondary" type="button" onClick={() => void exportSpreadsheet()}>
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
          if (file !== undefined) void chooseFile(file);
        }}
      />

      {status !== null && (
        <p className="flush-bottom" role="status">
          {status}
        </p>
      )}

      {problems.length > 0 && (
        <div className="warning space-above">
          <strong>{problems.length} row(s) could not be imported:</strong>
          <ul className="indent-list">
            {problems.slice(0, 10).map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
          {problems.length > 10 && <p className="flush">…and {problems.length - 10} more.</p>}
        </div>
      )}

      <p className="note flush-bottom">
        The JSON backup is the complete one — every vehicle, every fill-up, and the deletions
        too — and importing it merges rather than replaces, so restoring an old backup will not
        wipe out newer entries. The CSV is for spreadsheets: fill-ups only, in miles and US
        gallons whatever you have selected above, with the unit named in each column heading.
      </p>
    </section>
  );
}
