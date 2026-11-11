/**
 * Where the backup marker is kept, and the hook that reads it.
 *
 * The decision itself is in `domain/exportReminder.ts`; this is only storage
 * and React. Keeping them apart is what lets the rule be tested without a DOM.
 *
 * ## Per account, and per device
 *
 * An **account** preference (`preferences.ts`, #55). Per account because the
 * question is "has *this person's* data been saved anywhere?" — browser-wide,
 * account B's reminder compared B's fill-ups with A's last export, and could
 * stay silent while B held data that existed nowhere else.
 *
 * Still per device, so exporting on a laptop does not stop the phone asking.
 * That is a known cost, accepted: the alternative is syncing the marker, which
 * means a new synced field, which the `hasOnly` rule in `firestore.rules`
 * makes a two-part deploy. Over-nagging is the cheaper failure — and a prompt
 * on the phone is still *correct* if the laptop is the thing that was lost.
 *
 * A missing, unreadable or hand-edited value reads as "never backed up", which
 * errs toward prompting rather than toward silence. Storage that refuses the
 * write degrades the same way: the prompt reappears on the next load.
 */

import { useCallback, useEffect, useState } from 'react';
import type { BackupPromptReason, BackupState } from '../domain/exportReminder';
import { accountPreference, jsonCodec, readPreference, useAccountPreference } from './preferences';
import { NEVER_BACKED_UP, afterBackup, afterSnooze, backupPromptReason } from '../domain/exportReminder';

function isBackupState(value: unknown): value is BackupState {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const timestamp = (field: unknown): boolean =>
    field === null || (typeof field === 'number' && Number.isFinite(field));
  return (
    timestamp(candidate['lastExportAt']) &&
    typeof candidate['fillUpsAtLastExport'] === 'number' &&
    Number.isFinite(candidate['fillUpsAtLastExport']) &&
    timestamp(candidate['snoozedUntil'])
  );
}

const LAST_BACKUP = accountPreference('lastBackup', jsonCodec(isBackupState));

export function loadBackupState(uid: string | null): BackupState {
  return readPreference(LAST_BACKUP, uid) ?? NEVER_BACKED_UP;
}

export interface BackupNudge {
  readonly state: BackupState;
  /** Why a backup is being suggested, or null when it is not. */
  readonly reason: BackupPromptReason | null;
  /** Call once a JSON backup has actually been written. */
  readonly recordBackup: (fillUpCount: number) => void;
  /** Dismiss for a week. Deliberately not forever. */
  readonly snooze: () => void;
}

export function useBackupNudge(fillUpCount: number, uid: string | null): BackupNudge {
  const [state, setState] = useAccountPreference(LAST_BACKUP, uid, NEVER_BACKED_UP);
  // Recomputed on a timer as well as on render, so a banner appears on a page
  // left open across the threshold rather than only after an interaction.
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60 * 60 * 1000);
    return () => clearInterval(timer);
  }, []);

  const recordBackup = useCallback((count: number) => setState(afterBackup(count, Date.now())), [setState]);

  const snooze = useCallback(() => setState(afterSnooze(state, Date.now())), [setState, state]);

  return { state, reason: backupPromptReason(state, fillUpCount, now), recordBackup, snooze };
}
