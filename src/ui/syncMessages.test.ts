import { describe, expect, test } from 'vitest';
import { LEDGER_UNREADABLE, syncFailureMessage } from './syncMessages';

/**
 * What a failed sync says (#91). Sync reports *what* went wrong as a code; the
 * words are the screens' — they used to be written in `data/sync.ts`.
 */

describe('a failed sync, in words', () => {
  test('a refused account is told about access, and where to find the id that fixes it — not "could not reach"', () => {
    const text = syncFailureMessage({ problem: 'refused' });
    expect(text).toMatch(/access/i);
    expect(text).toMatch(/account id/i);
    expect(text).not.toMatch(/could not reach/i);
  });

  test('refused changes are said to be saved here, not that the account is refused', () => {
    const text = syncFailureMessage({ problem: 'rejected' });
    expect(text).toMatch(/saved on this device/i);
    expect(text).not.toMatch(/does not have access/i);
  });

  test('an unreachable account, with what went wrong when there is something to say', () => {
    expect(syncFailureMessage({ problem: 'pull-failed' })).toBe('Could not reach your account.');
    expect(syncFailureMessage({ problem: 'pull-failed', detail: 'offline' })).toBe('Could not reach your account. (offline)');
  });

  test('a failed upload says the changes are kept', () => {
    expect(syncFailureMessage({ problem: 'push-failed' })).toMatch(/not uploaded yet/i);
    expect(syncFailureMessage({ problem: 'push-failed', detail: 'quota' })).toMatch(/\(quota\)$/);
  });

  test('an unreadable share ledger is a pause to retry', () => {
    expect(syncFailureMessage({ problem: 'ledger-unreadable' })).toBe(LEDGER_UNREADABLE);
    expect(LEDGER_UNREADABLE).toMatch(/tried again/i);
  });

  test('a refusal never shows the raw cause, which is the SDK’s wording', () => {
    expect(syncFailureMessage({ problem: 'refused', detail: 'Missing or insufficient permissions.' })).not.toMatch(
      /insufficient/,
    );
  });
});
