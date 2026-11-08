/**
 * Where incremental sync keeps its place (#52).
 *
 * ## What the cursor records
 *
 * - **`highWater`** — per collection, the newest server stamp (`syncedAt`, as
 *   an exact integer of microseconds) this device has read. The next sync asks only for documents
 *   stamped after it. Per collection because the three collections are three
 *   reads at three moments: one shared mark taken from the latest of them could
 *   skip a write that landed in an earlier one between the reads. `null` means
 *   "read this collection in full".
 * - **Known versions**, kept beside the cursor rather than in it (#91) — the
 *   `updatedAt` of every row this device knows the account holds, keyed
 *   `collection/id`. Without the whole remote snapshot in hand, this is how
 *   sync decides what to upload (a local row newer than what the account
 *   has), and how the merge clock's floor is rebuilt after a reload. They
 *   used to be a field of the cursor, so every sync rewrote all of them; now
 *   a sync writes only the versions it read (`saveKnown`).
 * - **`fullPulledAt`** — when the last full read happened. A full read is
 *   repeated weekly as a safety net for anything an incremental read cannot
 *   see, such as a document deleted outright in the console.
 * - **`version` / `schemaVersion`** — a cursor written by different code is
 *   discarded, so a build that reads rows differently starts with a full read.
 *   Bump `SYNC_CURSOR_VERSION` to force that.
 *
 * ## Where it lives
 *
 * In the account's own IndexedDB database (`DexieSyncState` in `dexieState.ts`). The
 * cursor claims "this device holds everything up to here", which is only true
 * while those rows are on disk; stored anywhere that can outlive them, a
 * cleared database would be followed by a read that never fetches them again.
 */

import type { Collection, PullCursor } from './remote';
import { SCHEMA_VERSION } from './records';
import { isFiniteNumber } from './guards';

// 2 (#91): the known versions left the cursor. A version-1 cursor is
// discarded, and the full read that follows rebuilds them where they now live.
export const SYNC_CURSOR_VERSION = 2;

/** A full read at least this often, whatever the cursor says. */
export const FULL_RECONCILE_MS = 7 * 24 * 60 * 60 * 1000;

export interface SyncCursor {
  readonly version: number;
  readonly schemaVersion: number;
  readonly highWater: PullCursor;
  readonly fullPulledAt: number;
}

/** What a sync learned about the account's versions (#91). */
export interface KnownUpdate {
  /** Collections read in full: every version stored for them is replaced. */
  readonly replace: readonly Collection[];
  /** The versions just read, keyed `collection/id`. */
  readonly set: Readonly<Record<string, number>>;
}

export interface SyncStateStore {
  load(): Promise<SyncCursor | null>;
  save(cursor: SyncCursor): Promise<void>;
  /** Every version this device knows the account holds, keyed `collection/id`. */
  loadKnown(): Promise<Record<string, number>>;
  /** Writes what one sync learned — that alone, not the whole map again. */
  saveKnown(update: KnownUpdate): Promise<void>;
}

/** For tests, and for a session with no persistent store. */
export class InMemorySyncState implements SyncStateStore {
  private value: SyncCursor | null = null;
  private known = new Map<string, number>();

  async load(): Promise<SyncCursor | null> {
    return this.value;
  }

  async save(cursor: SyncCursor): Promise<void> {
    this.value = cursor;
  }

  async loadKnown(): Promise<Record<string, number>> {
    return Object.fromEntries(this.known);
  }

  async saveKnown(update: KnownUpdate): Promise<void> {
    for (const key of [...this.known.keys()]) {
      if (update.replace.includes(collectionOf(key))) this.known.delete(key);
    }
    for (const [key, at] of Object.entries(update.set)) this.known.set(key, at);
  }
}

/** The collection a `collection/id` key belongs to. */
export function collectionOf(key: string): Collection {
  return key.slice(0, key.indexOf('/')) as Collection;
}

const COLLECTIONS = ['vehicles', 'fillUps', 'pendingFillUps'] as const;


/**
 * A stored cursor, checked, or `null`. A damaged cursor costs one full read;
 * trusting it could cost rows, so anything off is discarded.
 */
export function parseCursor(value: unknown): SyncCursor | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!isFiniteNumber(raw.version) || !isFiniteNumber(raw.schemaVersion) || !isFiniteNumber(raw.fullPulledAt)) return null;

  const marks = raw.highWater;
  if (typeof marks !== 'object' || marks === null || Array.isArray(marks)) return null;
  const highWater: Record<string, number | null> = {};
  for (const name of COLLECTIONS) {
    const mark = (marks as Record<string, unknown>)[name];
    if (mark === null) highWater[name] = null;
    else if (isFiniteNumber(mark)) highWater[name] = mark;
    else return null;
  }

  // An older cursor's `known` field is ignored: it is a version-1 cursor,
  // which `usableCursor` discards anyway.
  return {
    version: raw.version,
    schemaVersion: raw.schemaVersion,
    highWater: highWater as PullCursor,
    fullPulledAt: raw.fullPulledAt,
  };
}

/** Whether a saved cursor may be used, or a full read is due. */
export function usableCursor(cursor: SyncCursor | null, now: number): cursor is SyncCursor {
  return (
    cursor !== null &&
    cursor.version === SYNC_CURSOR_VERSION &&
    cursor.schemaVersion === SCHEMA_VERSION &&
    cursor.fullPulledAt <= now &&
    now - cursor.fullPulledAt < FULL_RECONCILE_MS
  );
}
