/**
 * Writing a backup or a CSV export, in one place.
 *
 * Shared because there are three ways to ask for a backup — the button in
 * Settings, the reminder banner, and the no-access screen — and three copies
 * of "take a snapshot, serialise it, download it, record that it happened" is
 * three places for the recording to be forgotten. The no-access copy was the
 * one that forgot (#93). Only the fuel log calls these, and it records the
 * backup itself, so no screen has to remember.
 */

import type { FuelTrackerStore } from '../data/store';
import { backupFilename } from '../data/backup';
import { toCsv, toJsonBackup } from '../data/backupFormat';
import { downloadText } from './download';

export interface BackupSummary {
  readonly vehicles: number;
  /** **Live** fill-ups, matching what `store.fillUpCount()` counts. */
  readonly fillUps: number;
}

/**
 * Downloads a complete backup and reports what went into it.
 *
 * The snapshot includes tombstones — a backup that silently resurrected
 * deleted entries on restore would be worse than none — but the count returned
 * excludes them, because it is compared against `fillUpCount()` to decide when
 * to prompt again, and two different definitions of "how many fill-ups" would
 * drift people into spurious reminders.
 */
export async function saveJsonBackup(store: FuelTrackerStore): Promise<BackupSummary> {
  const snapshot = await store.exportSnapshot();
  downloadText(toJsonBackup(snapshot), backupFilename(), 'application/json');
  return {
    vehicles: snapshot.vehicles.filter((record) => record.deletedAt === null).length,
    fillUps: snapshot.fillUps.filter((record) => record.deletedAt === null).length,
  };
}

/**
 * Downloads the live fill-ups as CSV and says how many. Deliberately **not** a
 * backup: CSV is fill-ups only — no vehicles, no tombstones, no receipt bytes —
 * so counting it as one would tell somebody a restore will return what it will
 * not. Tombstones are left out because a deleted fill-up is not a row anybody
 * wants in their expenses.
 */
export async function saveCsvExport(store: FuelTrackerStore): Promise<number> {
  const snapshot = await store.exportSnapshot();
  const live = snapshot.fillUps.filter((record) => record.deletedAt === null);
  downloadText(toCsv(live), backupFilename(new Date(), 'csv'), 'text/csv');
  return live.length;
}
