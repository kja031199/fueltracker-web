/**
 * Whether to prompt for a backup, as a pure decision.
 *
 * Mirrors `onboardingGate.ts`: no storage, no UI, so the rule can be tested
 * rather than inferred from a render.
 *
 * ## Why this exists at all
 *
 * The account is not a backup. It is a second **live** copy, and it replicates
 * a mistake faithfully: a deletion travels as a tombstone and last-write-wins
 * carries it to every device, converging everywhere with no undo. Firestore's
 * free tier has no point-in-time recovery to fall back on.
 *
 * A JSON export is the only copy that survives both a bad delete and losing
 * access to the Google account — and before this, nothing ever suggested
 * taking one.
 */

/** Below this many entries there is not yet enough to be worth nagging about. */
export const MINIMUM_ENTRIES_TO_PROMPT = 5;

/** A month without a backup is long enough to ask. */
export const MAX_DAYS_BETWEEN_BACKUPS = 30;

/** Or this many new fill-ups, whichever comes first. */
export const MAX_ENTRIES_SINCE_BACKUP = 25;

/** How long a dismissal lasts. It snoozes; it does not silence. */
export const SNOOZE_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface BackupState {
  /** Epoch ms of the last **JSON** export, or null if there has never been one. */
  readonly lastExportAt: number | null;
  /** How many fill-ups existed at that export. */
  readonly fillUpsAtLastExport: number;
  /** Epoch ms until which the prompt is dismissed, or null. */
  readonly snoozedUntil: number | null;
}

export const NEVER_BACKED_UP: BackupState = {
  lastExportAt: null,
  fillUpsAtLastExport: 0,
  snoozedUntil: null,
};

export type BackupPromptReason = 'never' | 'stale' | 'manyNewEntries';

/**
 * Why a backup is being suggested, or `null` when it is not.
 *
 * Returning the reason rather than a boolean lets the banner say something
 * true — "you have never saved a backup" and "25 fill-ups since your last
 * backup" deserve different sentences, and a generic nag is the kind people
 * learn to dismiss without reading.
 */
export function backupPromptReason(
  state: BackupState,
  fillUpCount: number,
  now: number,
): BackupPromptReason | null {
  // Nothing worth losing yet. Nagging a brand-new reader is how you train
  // someone to ignore the banner that matters later.
  if (fillUpCount < MINIMUM_ENTRIES_TO_PROMPT) return null;

  if (state.snoozedUntil !== null && now < state.snoozedUntil) return null;

  if (state.lastExportAt === null) return 'never';

  // Clamped at zero. A device whose clock is ahead — or one that synced from
  // such a device — would otherwise record a backup "in the future" and
  // produce a negative age, which compares as fresh forever.
  const daysSince = Math.max(0, now - state.lastExportAt) / DAY_MS;
  if (daysSince > MAX_DAYS_BETWEEN_BACKUPS) return 'stale';

  // Deletions make this negative; a shrinking log is not a reason to back up.
  const added = fillUpCount - state.fillUpsAtLastExport;
  if (added >= MAX_ENTRIES_SINCE_BACKUP) return 'manyNewEntries';

  return null;
}

/** Convenience for callers that only need the yes/no. */
export function isBackupDue(state: BackupState, fillUpCount: number, now: number): boolean {
  return backupPromptReason(state, fillUpCount, now) !== null;
}

/** The state to record once a backup has actually been written. */
export function afterBackup(fillUpCount: number, now: number): BackupState {
  return { lastExportAt: now, fillUpsAtLastExport: fillUpCount, snoozedUntil: null };
}

/** The state to record when the prompt is dismissed. */
export function afterSnooze(state: BackupState, now: number): BackupState {
  return { ...state, snoozedUntil: now + SNOOZE_DAYS * DAY_MS };
}
