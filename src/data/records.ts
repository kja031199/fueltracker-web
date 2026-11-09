/**
 * What actually gets stored, as distinct from what the domain layer computes
 * over.
 *
 * The domain types in `src/domain/models.ts` describe a fill-up; these describe
 * a **row**. The separation is deliberate and is what kept Phase 1 testable
 * without a database: nothing under `src/domain/` knows that persistence
 * exists, and nothing here re-implements a rule that lives there.
 *
 * ## The four fields every row carries
 *
 * Sync is deferred, not designed away. Each record carries the four fields a
 * sync engine will need from the very first write, even though nothing reads
 * three of them yet — because they cost nothing now and cannot be added later
 * without migrating real user data:
 *
 * - `id` — a **client-generated UUID**, never an auto-increment. Non-negotiable:
 *   a server-assigned id cannot be reconciled with a row created offline.
 * - `updatedAt` — epoch milliseconds, set on every write. The basis for
 *   last-write-wins.
 * - `deletedAt` — a **tombstone**, not a row deletion. A hard delete leaves no
 *   trace to propagate, so a deleted row would reappear from another device.
 * - `schemaVersion` — stamped at write time so a future migration can tell what
 *   shape it is reading.
 */

import type { FuelGrade } from '../domain/fuelGrade';
import type { FuelEntryStats } from '../domain/models';

/**
 * The version of the stored shape. A row stamped with a higher one is never
 * read by this build — not from the account, not from a backup file (#86).
 *
 * **Bump it only for a breaking change**: a field removed, renamed, or given
 * a new meaning, where an older build reading the row would get it wrong. An
 * *added* field does not bump it. It is optional on the record, validation
 * reads its absence as the old behaviour, and the rules accept it **before**
 * any client writes it (deploy the rules first). `enteredBy` (#66) was added
 * that way. Bumping for it would have made every older build skip every row
 * a newer build had touched, which is far worse than dropping a name.
 */
export const SCHEMA_VERSION = 1;

export interface SyncFields {
  readonly id: string;
  readonly updatedAt: number;
  /** Epoch ms when tombstoned, or `null` while live. */
  readonly deletedAt: number | null;
  readonly schemaVersion: number;
}

export interface VehicleRecord extends SyncFields {
  readonly name: string;
  readonly make: string;
  readonly model: string;
  readonly year: number;
  readonly createdAt: number;
}

export interface FillUpRecord extends SyncFields {
  readonly vehicleId: string;
  /** Epoch ms. Stored as a number so it indexes and serialises cleanly. */
  readonly date: number;
  readonly odometer: number;
  readonly gallons: number;
  readonly pricePerGallon: number;
  readonly isFullTank: boolean;
  readonly missedPreviousFillUp: boolean;
  readonly fuelGrade: FuelGrade;
  readonly station: string;
  readonly notes: string;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly receiptImageData: Uint8Array | null;
  /**
   * The account that logged it (#66) — a uid, or `null` when nobody is known.
   * Optional because rows written before sharing existed have none. Set when a
   * fill-up is added, kept through every edit and deletion; on a shared car
   * the rules hold a member to their own uid.
   */
  readonly enteredBy?: string | null;
}

/**
 * A fill-up submitted by someone else, waiting for the owner to review it.
 *
 * Targets a vehicle by **id rather than a relationship**, exactly as upstream
 * does, so a submission can arrive and live independently of the owner's
 * vehicles — the shape a shared record needs. Approving it goes back through
 * the same validation a first-party entry does.
 */
export interface PendingFillUpRecord extends SyncFields {
  readonly vehicleId: string;
  readonly submittedAt: number;
  readonly submitterName: string;
  readonly date: number;
  readonly odometer: number;
  readonly gallons: number;
  readonly pricePerGallon: number;
  readonly isFullTank: boolean;
  readonly fuelGrade: FuelGrade;
  readonly station: string;
  readonly notes: string;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly receiptImageData: Uint8Array | null;
}

/**
 * Everything the store holds: every row of every collection, tombstones
 * included. What `exportSnapshot` returns, what `importBackup` merges, what a
 * sync pulls and pushes, and what a backup file wraps.
 *
 * Defined here, with the records, since #54. It was `BackupSnapshot` in
 * `domain/backupFormat.ts`, which made the store's central type a property of
 * a file format, and the domain layer and the data layer depend on each other.
 */
export interface Snapshot {
  readonly vehicles: readonly VehicleRecord[];
  readonly fillUps: readonly FillUpRecord[];
  readonly pendingFillUps: readonly PendingFillUpRecord[];
}


/**
 * Presence check for a usable receipt. Empty bytes count as none, so a stray
 * zero-length blob never shows an empty thumbnail slot.
 */
export function hasReceipt(
  record: Pick<FillUpRecord, 'receiptImageData'>,
): boolean {
  return record.receiptImageData !== null && record.receiptImageData.byteLength > 0;
}

/**
 * A fill-up as the screens hold it: everything except the photo bytes (#53).
 *
 * The list keeps one vehicle's fill-ups in React state for the whole session,
 * and nothing on it shows a photo — so carrying them there was memory spent on
 * nothing. Only *whether* there is one survives.
 *
 * **A distinct type, on purpose.** A list row with `receiptImageData: null`
 * would look exactly like a fill-up without a photo, and building the edit
 * form from one would save it back with the photo gone — silently. Without
 * the field, the compiler forces the edit path to load the whole row
 * (`store.fillUp(id)`).
 */
export type FillUpSummary = Omit<FillUpRecord, 'receiptImageData'> & {
  readonly hasReceipt: boolean;
};

export function toSummary(record: FillUpRecord): FillUpSummary {
  const { receiptImageData: _bytes, ...rest } = record;
  return { ...rest, hasReceipt: hasReceipt(record) };
}

/**
 * Stored rows in the shape the statistics layer reads.
 *
 * The bridge between the two halves of the app, and the only place that knows
 * both. Statistics never sees a record and storage never sees a `Date`-shaped
 * entry.
 */
export function toStats(
  records: readonly Pick<
    FillUpRecord,
    'id' | 'date' | 'odometer' | 'gallons' | 'pricePerGallon' | 'isFullTank' | 'missedPreviousFillUp'
  >[],
): FuelEntryStats[] {
  return records.map((record) => ({
    id: record.id,
    date: new Date(record.date),
    odometer: record.odometer,
    gallons: record.gallons,
    pricePerGallon: record.pricePerGallon,
    isFullTank: record.isFullTank,
    missedPreviousFillUp: record.missedPreviousFillUp,
  }));
}
