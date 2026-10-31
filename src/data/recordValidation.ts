/**
 * Checking that a record from the account is actually the shape it claims.
 *
 * ## Why this is needed even though nobody else can write there
 *
 * `firestore.rules` already guarantees that only the owner can write to their
 * own tree, so this is not defending against another user. It defends against
 * everything else that can put a wrong-shaped document there: a future build
 * with a different schema, a half-finished write, a hand edit in the Firebase
 * console, or a bug in this app that gets fixed later but leaves bad rows
 * behind.
 *
 * The existing protection was one line — `decode()` in `firebase/remoteStore.ts`
 * nulls a `receiptImageData` that is not `Bytes` — and `importBackup` then puts
 * every fill-up's **numbers** through the draft gate. Nothing checked *shape*.
 * So a document with `date: "yesterday"`, a `vehicleId` that is an object, or a
 * 900 KB `station` string was read straight into a typed record the rest of the
 * app believes, and from there into the statistics layer.
 *
 * ## Reject the row, or repair the field?
 *
 * Both, split on whether the field carries meaning that the app computes with:
 *
 * - **Reject** when something structural is wrong: a missing or non-string
 *   `id`, a non-finite `updatedAt`, a measurement that is not a number, a
 *   fill-up with no `vehicleId`. A row like that cannot be used, and guessing
 *   at it would invent data.
 * - **Repair** when the problem is cosmetic: text longer than any plausible
 *   human entry is truncated, and an unrecognised fuel grade becomes `Other`.
 *   Losing a whole fill-up — its odometer, its cost, its place in the MPG
 *   chain — because somebody pasted an essay into the notes field would be a
 *   worse outcome than shortening the essay.
 *
 * Every rejection is returned with a reason, so sync can report "3 rows from
 * your account were invalid and skipped" rather than silently dropping them.
 */

import { fuelGradeFromRaw } from '../domain/fuelGrade';
import type { BackupSnapshot } from '../domain/backupFormat';
import type { FillUpRecord, PendingFillUpRecord, VehicleRecord } from './records';

/**
 * Text bounds, set well beyond plausible human input rather than tightly.
 *
 * The entry form does not currently limit these fields, so a bound tight
 * enough to be "correct" would reject data the app itself accepted yesterday.
 * These are here to stop a document being inflated to the 1 MiB cap, not to
 * enforce a style guide.
 */
export const MAX_NAME_LENGTH = 200;
export const MAX_NOTES_LENGTH = 4000;
export const MAX_ID_LENGTH = 200;

/** Years outside this are not a car. The first automobile was 1886. */
const MIN_YEAR = 1885;
const MAX_YEAR = 2200;

export interface Validated<T> {
  readonly records: readonly T[];
  /** One reason per rejected row, suitable for showing a count of. */
  readonly rejected: readonly string[];
}

type Raw = Record<string, unknown>;

function isRaw(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A finite number, so `NaN` and `±Infinity` are both excluded. */
function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function text(value: unknown, max: number): string {
  // A non-string becomes empty rather than rejecting the row: these fields are
  // labels, and `String(value)` on an object would store "[object Object]",
  // which looks like real data and is worse than nothing.
  if (typeof value !== 'string') return '';
  return value.length > max ? value.slice(0, max) : value;
}

function flag(value: unknown): boolean {
  // Strictly boolean. A truthy string would make `isFullTank: "no"` mean true,
  // which silently changes how the whole MPG chain is computed.
  return value === true;
}

function coordinate(value: unknown): number | null {
  return finite(value) ? value : null;
}

function receipt(value: unknown): Uint8Array | null {
  return value instanceof Uint8Array && value.byteLength > 0 ? value : null;
}

/** The four fields every row must carry, or it cannot be reconciled at all. */
function syncFields(raw: Raw): { id: string; updatedAt: number; deletedAt: number | null; schemaVersion: number } | string {
  const { id, updatedAt, deletedAt, schemaVersion } = raw;
  if (typeof id !== 'string' || id === '') return 'missing id';
  if (id.length > MAX_ID_LENGTH) return 'id is implausibly long';
  if (!finite(updatedAt)) return 'updatedAt is not a number';
  if (deletedAt !== null && !finite(deletedAt)) return 'deletedAt is neither null nor a number';
  if (!finite(schemaVersion)) return 'schemaVersion is not a number';
  return { id, updatedAt, deletedAt: deletedAt === null ? null : deletedAt, schemaVersion };
}

export function validateVehicle(value: unknown): VehicleRecord | string {
  if (!isRaw(value)) return 'vehicle: not an object';
  const common = syncFields(value);
  if (typeof common === 'string') return `vehicle: ${common}`;
  if (!finite(value.createdAt)) return `vehicle ${common.id}: createdAt is not a number`;

  const year = finite(value.year) ? Math.trunc(value.year) : 0;
  return {
    ...common,
    name: text(value.name, MAX_NAME_LENGTH),
    make: text(value.make, MAX_NAME_LENGTH),
    model: text(value.model, MAX_NAME_LENGTH),
    // Out-of-range becomes 0, which the UI already renders as "no year given"
    // rather than a date nobody drove in.
    year: year >= MIN_YEAR && year <= MAX_YEAR ? year : 0,
    createdAt: value.createdAt,
  };
}

/** The measurement fields, shared by fill-ups and pending submissions. */
function measurements(
  value: Raw,
  id: string,
): { date: number; odometer: number; gallons: number; pricePerGallon: number } | string {
  if (!finite(value.date)) return `fill-up ${id}: date is not a number`;
  if (!finite(value.odometer)) return `fill-up ${id}: odometer is not a number`;
  if (!finite(value.gallons)) return `fill-up ${id}: gallons is not a number`;
  if (!finite(value.pricePerGallon)) return `fill-up ${id}: price is not a number`;
  return {
    date: value.date,
    odometer: value.odometer,
    gallons: value.gallons,
    pricePerGallon: value.pricePerGallon,
  };
}

export function validateFillUp(value: unknown): FillUpRecord | string {
  if (!isRaw(value)) return 'fill-up: not an object';
  const common = syncFields(value);
  if (typeof common === 'string') return `fill-up: ${common}`;
  if (typeof value.vehicleId !== 'string' || value.vehicleId === '') {
    return `fill-up ${common.id}: missing vehicleId`;
  }

  // A tombstone is a record that something was deleted. It carries no usable
  // measurements and does not need to — the same reasoning `importBackup`
  // applies when it skips the draft gate for one.
  if (common.deletedAt !== null) {
    return {
      ...common,
      vehicleId: value.vehicleId,
      date: finite(value.date) ? value.date : 0,
      odometer: 0,
      gallons: 0,
      pricePerGallon: 0,
      isFullTank: false,
      missedPreviousFillUp: false,
      fuelGrade: 'Other',
      station: '',
      notes: '',
      latitude: null,
      longitude: null,
      receiptImageData: null,
    };
  }

  const numbers = measurements(value, common.id);
  if (typeof numbers === 'string') return numbers;

  return {
    ...common,
    vehicleId: value.vehicleId,
    ...numbers,
    isFullTank: flag(value.isFullTank),
    missedPreviousFillUp: flag(value.missedPreviousFillUp),
    // Reuses the ported fallback rather than deciding again here: an
    // unrecognised grade has always become `Other`, on iOS and on the web.
    fuelGrade: fuelGradeFromRaw(typeof value.fuelGrade === 'string' ? value.fuelGrade : ''),
    station: text(value.station, MAX_NAME_LENGTH),
    notes: text(value.notes, MAX_NOTES_LENGTH),
    latitude: coordinate(value.latitude),
    longitude: coordinate(value.longitude),
    receiptImageData: receipt(value.receiptImageData),
  };
}

export function validatePending(value: unknown): PendingFillUpRecord | string {
  if (!isRaw(value)) return 'submission: not an object';
  const common = syncFields(value);
  if (typeof common === 'string') return `submission: ${common}`;
  if (typeof value.vehicleId !== 'string' || value.vehicleId === '') {
    return `submission ${common.id}: missing vehicleId`;
  }
  if (!finite(value.submittedAt)) return `submission ${common.id}: submittedAt is not a number`;

  const numbers = measurements(value, common.id);
  if (typeof numbers === 'string') return numbers.replace('fill-up', 'submission');

  return {
    ...common,
    vehicleId: value.vehicleId,
    submittedAt: value.submittedAt,
    submitterName: text(value.submitterName, MAX_NAME_LENGTH),
    ...numbers,
    isFullTank: flag(value.isFullTank),
    fuelGrade: fuelGradeFromRaw(typeof value.fuelGrade === 'string' ? value.fuelGrade : ''),
    station: text(value.station, MAX_NAME_LENGTH),
    notes: text(value.notes, MAX_NOTES_LENGTH),
    latitude: coordinate(value.latitude),
    longitude: coordinate(value.longitude),
    receiptImageData: receipt(value.receiptImageData),
  };
}

function partition<T>(
  rows: readonly unknown[],
  validate: (value: unknown) => T | string,
): Validated<T> {
  const records: T[] = [];
  const rejected: string[] = [];
  for (const row of rows) {
    const result = validate(row);
    if (typeof result === 'string') rejected.push(result);
    else records.push(result);
  }
  return { records, rejected };
}

export interface ValidatedSnapshot {
  readonly snapshot: BackupSnapshot;
  readonly rejected: readonly string[];
}

/**
 * Validates a whole pulled snapshot, keeping what is usable.
 *
 * One bad document must not cost the other nine hundred — the same rule the
 * file-import path follows, for the same reason.
 */
export function validateSnapshot(raw: {
  readonly vehicles: readonly unknown[];
  readonly fillUps: readonly unknown[];
  readonly pendingFillUps: readonly unknown[];
}): ValidatedSnapshot {
  const vehicles = partition(raw.vehicles, validateVehicle);
  const fillUps = partition(raw.fillUps, validateFillUp);
  const pendingFillUps = partition(raw.pendingFillUps, validatePending);
  return {
    snapshot: {
      vehicles: vehicles.records,
      fillUps: fillUps.records,
      pendingFillUps: pendingFillUps.records,
    },
    rejected: [...vehicles.rejected, ...fillUps.rejected, ...pendingFillUps.rejected],
  };
}
