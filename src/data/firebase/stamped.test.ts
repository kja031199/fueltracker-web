import { describe, expect, test } from 'vitest';
import { Timestamp } from 'firebase/firestore';
import { readStamped, toMicros } from './remoteStore';

/**
 * The one read loop both Firestore remotes use (#91): rows decoded, and the
 * newest server stamp among them as the next read's mark.
 */
const doc = (data: Record<string, unknown>) => ({ data: () => data });

describe('readStamped', () => {
  test('the mark is the newest stamp, and the stamp is not part of a row', () => {
    const older = new Timestamp(1_700_000_000, 1_000);
    const newer = new Timestamp(1_700_000_005, 2_000);
    const { rows, highWater } = readStamped([doc({ id: 'a', syncedAt: newer }), doc({ id: 'b', syncedAt: older })]);
    expect(highWater).toBe(toMicros(newer));
    expect(rows.map((row) => row['id'])).toEqual(['a', 'b']);
    for (const row of rows) expect('syncedAt' in row).toBe(false);
  });

  test('documents from before stamps existed move no mark', () => {
    expect(readStamped([doc({ id: 'old' })]).highWater).toBeNull();
    expect(readStamped([]).highWater).toBeNull();
  });

  test('a stamp that is not a server timestamp is ignored, not trusted', () => {
    const { highWater } = readStamped([
      doc({ id: 'a', syncedAt: 9_999_999_999_999 }),
      doc({ id: 'b', syncedAt: 'now' }),
    ]);
    expect(highWater).toBeNull();
  });
});
