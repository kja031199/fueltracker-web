/**
 * Where the backup marker is kept, and the hook that reads it.
 *
 * The decision itself is in `domain/exportReminder.ts`; this is only storage
 * and React. Keeping them apart is what lets the rule be tested without a DOM.
 *
 * ## Per device, deliberately
 *
 * `localStorage`, so exporting on a laptop does not stop the phone asking.
 * That is a known cost, accepted: the alternative is syncing the marker, which
 * means a new synced field, which the `hasOnly` rule in `firestore.rules`
 * makes a two-part deploy. Over-nagging is the cheaper failure — and a prompt
 * on the phone is still *correct* if the laptop is the thing that was lost.
 *
 * Every read is defensive, in the style of `unitSettings.ts`: storage can be
 * unavailable in private mode, and a stored value can be anything at all if it
 * was hand-edited or written by an older build. A bad value reads as "never
 * backed up", which errs toward prompting rather than toward silence.
 */

import { useCallback, useEffect, useState } from 'react';
import type { BackupPromptReason, BackupState } from '../domain/exportReminder';
import {
  NEVER_BACKED_UP,
  afterBackup,
  afterSnooze,
  backupPromptReason,
} from '../domain/exportReminder';

const STORAGE_KEY = 'fueltracker.lastBackup';

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

export function loadBackupState(): BackupState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return NEVER_BACKED_UP;
    const parsed: unknown = JSON.parse(raw);
    return isBackupState(parsed) ? parsed : NEVER_BACKED_UP;
  } catch {
    // Unavailable storage, or text that is not JSON. Either way the honest
    // answer is that we have no evidence of a backup.
    return NEVER_BACKED_UP;
  }
}

export function saveBackupState(state: BackupState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Private mode with storage blocked. The prompt then reappears next load,
    // which is the right way for this particular failure to degrade.
  }
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

export function useBackupNudge(fillUpCount: number): BackupNudge {
  const [state, setState] = useState<BackupState>(() => loadBackupState());
  // Recomputed on a timer as well as on render, so a banner appears on a page
  // left open across the threshold rather than only after an interaction.
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60 * 60 * 1000);
    return () => clearInterval(timer);
  }, []);

  const recordBackup = useCallback((count: number) => {
    const next = afterBackup(count, Date.now());
    setState(next);
    saveBackupState(next);
  }, []);

  const snooze = useCallback(() => {
    setState((current) => {
      const next = afterSnooze(current, Date.now());
      saveBackupState(next);
      return next;
    });
  }, []);

  return { state, reason: backupPromptReason(state, fillUpCount, now), recordBackup, snooze };
}
