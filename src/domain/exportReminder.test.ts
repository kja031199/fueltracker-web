import { describe, expect, it } from 'vitest';
import {
  MAX_DAYS_BETWEEN_BACKUPS,
  MAX_ENTRIES_SINCE_BACKUP,
  MINIMUM_ENTRIES_TO_PROMPT,
  NEVER_BACKED_UP,
  SNOOZE_DAYS,
  afterBackup,
  afterSnooze,
  backupPromptReason,
  isBackupDue,
  type BackupState,
} from './exportReminder';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-06-15T12:00:00Z').getTime();

function state(overrides: Partial<BackupState> = {}): BackupState {
  return { ...NEVER_BACKED_UP, ...overrides };
}

describe('when a backup is worth asking for', () => {
  it('asks someone who has never taken one', () => {
    expect(backupPromptReason(state(), 10, NOW)).toBe('never');
  });

  it('asks when the last one is older than the limit', () => {
    const last = NOW - (MAX_DAYS_BETWEEN_BACKUPS + 1) * DAY;
    expect(backupPromptReason(state({ lastExportAt: last }), 10, NOW)).toBe('stale');
  });

  it('asks after enough new fill-ups even if the backup is recent', () => {
    // A heavy month deserves a prompt before the calendar says so.
    const recent = state({ lastExportAt: NOW - DAY, fillUpsAtLastExport: 10 });
    expect(backupPromptReason(recent, 10 + MAX_ENTRIES_SINCE_BACKUP, NOW)).toBe('manyNewEntries');
  });
});

describe('when it stays quiet', () => {
  it('says nothing to a reader with almost no data', () => {
    // Nagging a brand-new reader is how you train someone to ignore the
    // banner that matters later.
    expect(backupPromptReason(state(), MINIMUM_ENTRIES_TO_PROMPT - 1, NOW)).toBeNull();
  });

  it('says nothing with no fill-ups at all', () => {
    expect(backupPromptReason(state(), 0, NOW)).toBeNull();
  });

  it('says nothing after a recent backup with few additions', () => {
    const recent = state({ lastExportAt: NOW - DAY, fillUpsAtLastExport: 10 });
    expect(backupPromptReason(recent, 12, NOW)).toBeNull();
  });

  it('says nothing while snoozed', () => {
    const snoozed = state({ snoozedUntil: NOW + DAY });
    expect(backupPromptReason(snoozed, 100, NOW)).toBeNull();
  });

  it('speaks up again once the snooze expires', () => {
    // Dismissal snoozes, it does not silence. A permanent dismissal would
    // quietly re-open the risk this exists to close.
    const expired = state({ snoozedUntil: NOW - 1 });
    expect(backupPromptReason(expired, 100, NOW)).toBe('never');
  });
});

describe('the exact boundaries', () => {
  it('is quiet at exactly the minimum entry count minus one, and asks at the minimum', () => {
    expect(isBackupDue(state(), MINIMUM_ENTRIES_TO_PROMPT - 1, NOW)).toBe(false);
    expect(isBackupDue(state(), MINIMUM_ENTRIES_TO_PROMPT, NOW)).toBe(true);
  });

  it('is quiet at exactly the day limit and asks just past it', () => {
    const exactly = state({ lastExportAt: NOW - MAX_DAYS_BETWEEN_BACKUPS * DAY });
    expect(backupPromptReason(exactly, 10, NOW)).toBeNull();

    const past = state({ lastExportAt: NOW - MAX_DAYS_BETWEEN_BACKUPS * DAY - 1 });
    expect(backupPromptReason(past, 10, NOW)).toBe('stale');
  });

  it('asks at exactly the new-entry limit, not one past it', () => {
    const base = state({ lastExportAt: NOW - DAY, fillUpsAtLastExport: 10 });
    expect(backupPromptReason(base, 10 + MAX_ENTRIES_SINCE_BACKUP - 1, NOW)).toBeNull();
    expect(backupPromptReason(base, 10 + MAX_ENTRIES_SINCE_BACKUP, NOW)).toBe('manyNewEntries');
  });

  it('is quiet at the exact moment a snooze ends, and asks after it', () => {
    expect(backupPromptReason(state({ snoozedUntil: NOW }), 100, NOW)).toBe('never');
    expect(backupPromptReason(state({ snoozedUntil: NOW + 1 }), 100, NOW)).toBeNull();
  });
});

describe('degenerate and hostile input', () => {
  it('does not nag forever over a backup dated in the future', () => {
    // A device with a wrong clock records a backup "in the future". Without
    // clamping, the age is negative, which compares as fresh for as long as
    // the skew lasts — a silent way to stop prompting someone entirely.
    const skewed = state({ lastExportAt: NOW + 365 * DAY, fillUpsAtLastExport: 10 });
    expect(backupPromptReason(skewed, 12, NOW)).toBeNull();

    // And the count rule still works on it, so a skewed clock cannot disable
    // the prompt outright.
    expect(backupPromptReason(skewed, 10 + MAX_ENTRIES_SINCE_BACKUP, NOW)).toBe('manyNewEntries');
  });

  it('does not treat deletions as a reason to back up', () => {
    // Fewer fill-ups than at the last export makes the delta negative.
    const after = state({ lastExportAt: NOW - DAY, fillUpsAtLastExport: 50 });
    expect(backupPromptReason(after, 10, NOW)).toBeNull();
  });

  it('survives a snooze dated absurdly far ahead by still respecting it', () => {
    // Nothing here can repair a nonsense stored value; what matters is that it
    // does not throw and that clearing it is one export away.
    const forever = state({ snoozedUntil: NOW + 1000 * 365 * DAY });
    expect(() => backupPromptReason(forever, 100, NOW)).not.toThrow();
    expect(backupPromptReason(forever, 100, NOW)).toBeNull();
  });

  it('handles a zero timestamp as a real, very old backup', () => {
    expect(backupPromptReason(state({ lastExportAt: 0 }), 10, NOW)).toBe('stale');
  });
});

describe('recording what happened', () => {
  it('a backup clears the prompt', () => {
    const recorded = afterBackup(42, NOW);
    expect(recorded).toEqual({ lastExportAt: NOW, fillUpsAtLastExport: 42, snoozedUntil: null });
    expect(isBackupDue(recorded, 42, NOW)).toBe(false);
  });

  it('a backup also clears an existing snooze', () => {
    // Otherwise someone who dismissed and then exported would be told nothing
    // for a week about a backup they had already taken — harmless, but it
    // would make the stored state disagree with reality.
    const snoozed = afterSnooze(state(), NOW);
    expect(afterBackup(42, NOW).snoozedUntil).toBeNull();
    expect(snoozed.snoozedUntil).not.toBeNull();
  });

  it('a snooze lasts exactly the stated number of days', () => {
    const snoozed = afterSnooze(state(), NOW);
    expect(snoozed.snoozedUntil).toBe(NOW + SNOOZE_DAYS * DAY);
    expect(isBackupDue(snoozed, 100, NOW + (SNOOZE_DAYS - 1) * DAY)).toBe(false);
    expect(isBackupDue(snoozed, 100, NOW + SNOOZE_DAYS * DAY)).toBe(true);
  });

  it('a snooze keeps the backup history rather than resetting it', () => {
    const had = state({ lastExportAt: NOW - DAY, fillUpsAtLastExport: 7 });
    const snoozed = afterSnooze(had, NOW);
    expect(snoozed.lastExportAt).toBe(had.lastExportAt);
    expect(snoozed.fillUpsAtLastExport).toBe(7);
  });
});
