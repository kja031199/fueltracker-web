/**
 * The prompt to take a backup.
 *
 * A banner rather than a line in Settings, because the point is mitigating
 * data loss and a prompt nobody sees mitigates nothing.
 *
 * `role="status"`, matching `UpdateBanner`: it must not seize a screen reader
 * mid-sentence. The risk is real but it is not an emergency, and an `alert`
 * here would be the kind of urgency that teaches people to ignore alerts.
 */

import type { ReactElement } from 'react';
import type { BackupPromptReason } from '../domain/exportReminder';
import { MAX_ENTRIES_SINCE_BACKUP } from '../domain/exportReminder';

interface Props {
  readonly reason: BackupPromptReason | null;
  readonly onBackUp: () => void;
  readonly onDismiss: () => void;
}

/**
 * Says the true thing rather than a generic nag.
 *
 * "You have never saved a backup" and "25 fill-ups since your last backup"
 * deserve different sentences; one message for both is what people learn to
 * dismiss without reading.
 */
function message(reason: BackupPromptReason): string {
  switch (reason) {
    case 'never':
      return 'You have never saved a backup. It is the only copy that does not depend on your Google account.';
    case 'stale':
      return 'It has been over a month since your last backup.';
    case 'manyNewEntries':
      return `You have added ${MAX_ENTRIES_SINCE_BACKUP} or more fill-ups since your last backup.`;
  }
}

export function BackupBanner({ reason, onBackUp, onDismiss }: Props): ReactElement | null {
  if (reason === null) return null;

  return (
    <div className="banner" role="status">
      <span>{message(reason)}</span>
      <button className="button" type="button" onClick={onBackUp}>
        Save a backup
      </button>
      <button className="button button--secondary" type="button" onClick={onDismiss}>
        Not now
      </button>
    </div>
  );
}
