/**
 * What a deletion leaves behind.
 *
 * ## The bug this file exists to close (#25)
 *
 * A tombstone used to be written as `{ ...row, deletedAt: now }`. That keeps
 * **every field**, so a deleted fill-up still held its receipt photograph, its
 * notes, its station and its coordinates — on the device, on every device it
 * synced to, in the account, and inside every backup taken afterwards. Delete
 * is the only control anyone has over those photographs, and it was hiding
 * them from a list rather than removing them.
 *
 * `recordValidation.validateFillUp` had already assumed the opposite for years:
 * an incoming tombstone is rebuilt there with zeroed measurements, empty text
 * and no receipt, under a comment saying a tombstone "carries no usable
 * measurements and does not need to". The reader was right and the writer was
 * wrong. These functions make the writer agree.
 *
 * ## Why the fields are emptied rather than dropped
 *
 * `firestore.rules` checks `hasOnly` **and** `hasAll` on every collection, so a
 * document must carry exactly the known keys. Emptying a value is allowed;
 * omitting the key is a refused write. So a tombstone is a full-shaped record
 * whose content is gone — which is also what keeps the local type honest
 * (`FillUpRecord` has no optional fields).
 *
 * ## What is kept, and why only this
 *
 * The four sync fields, plus `vehicleId` on the two row types that have one.
 * That is exactly what reconciliation needs: an id to match on, an `updatedAt`
 * to compare, a `deletedAt` to mean "deleted", a `schemaVersion` to read it by,
 * and the vehicle so a cascade can still be understood. Nothing else — not
 * even `date`, which on its own says somebody bought fuel that day.
 *
 * `schemaVersion` is carried over rather than restamped: a deletion is not a
 * migration, and relabelling a row this build did not fully understand would
 * be a lie about where it came from.
 */

import type {
  FillUpRecord,
  PendingFillUpRecord,
  SyncFields,
  VehicleRecord,
} from './records';

/** A function that turns a live row into its tombstone, stamped at `at`. */
export type Tombstoner<T extends SyncFields> = (row: T, at: number) => T;

export const tombstoneVehicle: Tombstoner<VehicleRecord> = (row, at) => ({
  id: row.id,
  updatedAt: at,
  deletedAt: at,
  schemaVersion: row.schemaVersion,
  name: '',
  make: '',
  model: '',
  year: 0,
  createdAt: 0,
});

export const tombstoneFillUp: Tombstoner<FillUpRecord> = (row, at) => ({
  id: row.id,
  updatedAt: at,
  deletedAt: at,
  schemaVersion: row.schemaVersion,
  vehicleId: row.vehicleId,
  date: 0,
  odometer: 0,
  gallons: 0,
  pricePerGallon: 0,
  isFullTank: false,
  missedPreviousFillUp: false,
  // `Other` rather than an empty string: the field is typed as a `FuelGrade`,
  // and this is the same fallback `fuelGradeFromRaw` and `validateFillUp`
  // already use for a grade they cannot read.
  fuelGrade: 'Other',
  station: '',
  notes: '',
  latitude: null,
  longitude: null,
  receiptImageData: null,
});

export const tombstonePending: Tombstoner<PendingFillUpRecord> = (row, at) => ({
  id: row.id,
  updatedAt: at,
  deletedAt: at,
  schemaVersion: row.schemaVersion,
  vehicleId: row.vehicleId,
  // A submission is the one record here written by somebody else. Their name
  // and their note are the first things to go when it is rejected.
  submittedAt: 0,
  submitterName: '',
  date: 0,
  odometer: 0,
  gallons: 0,
  pricePerGallon: 0,
  isFullTank: false,
  fuelGrade: 'Other',
  station: '',
  notes: '',
  latitude: null,
  longitude: null,
  receiptImageData: null,
});

/** Bytes compare by length; `null` and bytes are never the same thing. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    return a instanceof Uint8Array && b instanceof Uint8Array && a.byteLength === b.byteLength;
  }
  return a === b;
}

/**
 * Whether a tombstone is already as empty as this build would write it.
 *
 * Used by the one-time cleanup to find rows left fat by an older build, and
 * written as a comparison against the builder rather than as a list of
 * "fields that should be empty" — so a field added to a record later is
 * covered on the day it is added, without anyone remembering to come back
 * here. A new field that the builder empties and an old row carries reads as
 * dirty, which is the safe direction.
 *
 * `updatedAt` is deliberately not compared: rewriting a row bumps it, so
 * comparing it would report every scrubbed row as still dirty and rewrite it
 * on every load — a write loop, with a sync loop behind it.
 */
export function isScrubbed<T extends SyncFields>(row: T, tombstone: Tombstoner<T>): boolean {
  const expected = tombstone(row, row.deletedAt ?? row.updatedAt);
  const keys = new Set([...Object.keys(row), ...Object.keys(expected)]);
  keys.delete('updatedAt');
  for (const key of keys) {
    if (!sameValue((row as Record<string, unknown>)[key], (expected as Record<string, unknown>)[key])) {
      return false;
    }
  }
  return true;
}
