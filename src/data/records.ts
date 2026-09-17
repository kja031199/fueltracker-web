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

/** Bump when a stored shape changes in a way a reader must know about. */
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
 * Total cost is always derived from gallons × price, never stored — the same
 * rule the domain layer follows. A stored total is a second source of truth
 * that can disagree with its own inputs.
 */
export function recordTotalCost(
  record: Pick<FillUpRecord, 'gallons' | 'pricePerGallon'>,
): number {
  return record.gallons * record.pricePerGallon;
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
