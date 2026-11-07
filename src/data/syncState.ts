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
 * - **`known`** — the `updatedAt` of every row this device knows the account
 *   holds, keyed `collection/id`. Without the whole remote snapshot in hand,
 *   this is how sync decides what to upload (a local row newer than what the
 *   account has), and how the merge clock's floor is rebuilt after a reload.
 * - **`fullPulledAt`** — when the last full read happened. A full read is
 *   repeated weekly as a safety net for anything an incremental read cannot
 *   see, such as a document deleted outright in the console.
 * - **`version` / `schemaVersion`** — a cursor written by different code is
 *   discarded, so a build that reads rows differently starts with a full read.
 *   Bump `SYNC_CURSOR_VERSION` to force that.
 *
 * ## Where it lives
 *
 * In the account's own IndexedDB database (`DexieSyncState` in `db.ts`). The
 * cursor claims "this device holds everything up to here", which is only true
 * while those rows are on disk; stored anywhere that can outlive them, a
 * cleared database would be followed by a read that never fetches them again.
 */

import type { PullCursor } from './remote';
import { SCHEMA_VERSION } from './records';
import type { Membership } from './sharing';
import { isStorableId } from './recordId';
import { TEXT_LIMITS, boundText } from '../domain/textLimits';

export const SYNC_CURSOR_VERSION = 1;

/** A full read at least this often, whatever the cursor says. */
export const FULL_RECONCILE_MS = 7 * 24 * 60 * 60 * 1000;

export interface SyncCursor {
  readonly version: number;
  readonly schemaVersion: number;
  readonly highWater: PullCursor;
  readonly known: Readonly<Record<string, number>>;
  readonly fullPulledAt: number;
}

export interface SyncStateStore {
  load(): Promise<SyncCursor | null>;
  save(cursor: SyncCursor): Promise<void>;
}

/** For tests, and for a session with no persistent store. */
export class InMemorySyncState implements SyncStateStore {
  private value: SyncCursor | null = null;

  async load(): Promise<SyncCursor | null> {
    return this.value;
  }

  async save(cursor: SyncCursor): Promise<void> {
    this.value = cursor;
  }
}

const COLLECTIONS = ['vehicles', 'fillUps', 'pendingFillUps'] as const;

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * A stored cursor, checked, or `null`. A damaged cursor costs one full read;
 * trusting it could cost rows, so anything off is discarded.
 */
export function parseCursor(value: unknown): SyncCursor | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!finite(raw.version) || !finite(raw.schemaVersion) || !finite(raw.fullPulledAt)) return null;

  const marks = raw.highWater;
  if (typeof marks !== 'object' || marks === null || Array.isArray(marks)) return null;
  const highWater: Record<string, number | null> = {};
  for (const name of COLLECTIONS) {
    const mark = (marks as Record<string, unknown>)[name];
    if (mark === null) highWater[name] = null;
    else if (finite(mark)) highWater[name] = mark;
    else return null;
  }

  const knownRaw = raw.known;
  if (typeof knownRaw !== 'object' || knownRaw === null || Array.isArray(knownRaw)) return null;
  const known: Record<string, number> = {};
  for (const [key, at] of Object.entries(knownRaw)) {
    if (!finite(at)) return null;
    known[key] = at;
  }

  return {
    version: raw.version,
    schemaVersion: raw.schemaVersion,
    highWater: highWater as PullCursor,
    known,
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

// --- Cars shared with this account (#66) -----------------------------------

/** The shared cars this device holds rows for. See `DexieShareLedger`. */
export interface ShareLedger {
  load(): Promise<Membership[]>;
  save(list: readonly Membership[]): Promise<void>;
}

export class InMemoryShareLedger implements ShareLedger {
  private list: Membership[] = [];

  async load(): Promise<Membership[]> {
    return [...this.list];
  }

  async save(list: readonly Membership[]): Promise<void> {
    this.list = [...list];
  }
}

/** A stored ledger, keeping only well-formed entries. Junk reads as none. */
export function parseLedger(value: unknown): Membership[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const raw = entry as Record<string, unknown>;
    // Both become document paths and scope keys, and the account's copy is
    // read from the network (#86): an id that could not name a document is
    // not a share, whatever else the entry says.
    if (!isStorableId(raw.ownerUid) || !isStorableId(raw.vehicleId)) return [];
    return [
      {
        ownerUid: raw.ownerUid,
        vehicleId: raw.vehicleId,
        ownerName: typeof raw.ownerName === 'string' ? boundText(raw.ownerName, TEXT_LIMITS.ownerName) : '',
        vehicleName: typeof raw.vehicleName === 'string' ? boundText(raw.vehicleName, TEXT_LIMITS.vehicleName) : '',
      },
    ];
  });
}
