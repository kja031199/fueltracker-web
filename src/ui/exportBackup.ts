/**
 * Writing a JSON backup, in one place.
 *
 * Shared because there are now two ways to ask for one — the button in
 * Settings and the reminder banner — and two copies of "take a snapshot,
 * serialise it, download it, record that it happened" is two places for the
 * recording to be forgotten.
 */

import type { FuelTrackerStore } from '../data/store';
import { backupFilename } from '../data/backup';
import { toJsonBackup } from '../domain/backupFormat';
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
