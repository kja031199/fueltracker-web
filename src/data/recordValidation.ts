/**
 * Checking that a record from the account is actually the shape it claims.
 *
 * ## Why this is needed even though the rules guard every write
 *
 * `firestore.rules` already guarantees that only the owner — and, for a shared
 * car's fill-ups, its members (#66) — can write to a tree, and holds every
 * write to the record's shape. It defends against
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
import { TEXT_LIMITS } from '../domain/textLimits';
import { MAX_RECEIPT_BYTES } from '../domain/fuelEntryDraft';
import { idProblem } from './recordId';
import type { FillUpRecord, PendingFillUpRecord, VehicleRecord, Snapshot } from './records';
import { tombstoneFillUp, tombstonePending } from './tombstone';
import { isFiniteNumber, isRecord, textOr } from './guards';

// Re-exported rather than redefined: the id rule outgrew a length check once
// it turned out an id is also a Firestore document name (#26), and it lives in
// `recordId.ts` so the import path can apply exactly the same one.
export { MAX_ID_LENGTH } from './recordId';

/** Years outside this are not a car. The first automobile was 1886. */
const MIN_YEAR = 1885;
const MAX_YEAR = 2200;

export interface Validated<T> {
  readonly records: readonly T[];
  /** One reason per rejected row, suitable for showing a count of. */
  readonly rejected: readonly string[];
}

type Raw = Record<string, unknown>;

function flag(value: unknown): boolean {
  // Strictly boolean. A truthy string would make `isFullTank: "no"` mean true,
  // which silently changes how the whole MPG chain is computed.
  return value === true;
}

function coordinate(value: unknown): number | null {
  return isFiniteNumber(value) ? value : null;
}

/**
 * Receipt bytes, bounded by the same ceiling every write path applies.
 *
 * Firestore's 1 MiB document cap means an oversized photo cannot reach here
 * through sync today, so this is defence in depth — but the rule worth holding
 * is "every path that admits a receipt applies the same bound", not "the bound
 * applies except where some other system happens to cap it". A future remote,
 * or a future document limit, should not be what decides this.
 *
 * Oversized drops the photo and keeps the row, as everywhere else: the
 * odometer reading is what the statistics are built on.
 */
function receipt(value: unknown): Uint8Array | null {
  if (!(value instanceof Uint8Array)) return null;
  if (value.byteLength === 0 || value.byteLength > MAX_RECEIPT_BYTES) return null;
  return value;
}

/** The four fields every row must carry, or it cannot be reconciled at all. */
function syncFields(
  raw: Raw,
): { id: string; updatedAt: number; deletedAt: number | null; schemaVersion: number } | string {
  const { id, updatedAt, deletedAt, schemaVersion } = raw;
  // An id that cannot be stored is not a cosmetic fault to repair: it is the
  // name of a document, and a row carrying one stops every later push (#26).
  const badId = idProblem(id);
  if (badId !== null || typeof id !== 'string') return badId ?? 'no id';
  if (!isFiniteNumber(updatedAt)) return 'updatedAt is not a number';
  if (deletedAt !== null && !isFiniteNumber(deletedAt)) return 'deletedAt is neither null nor a number';
  if (!isFiniteNumber(schemaVersion)) return 'schemaVersion is not a number';
  return { id, updatedAt, deletedAt: deletedAt === null ? null : deletedAt, schemaVersion };
}

export function validateVehicle(value: unknown): VehicleRecord | string {
  if (!isRecord(value)) return 'vehicle: not an object';
  const common = syncFields(value);
  if (typeof common === 'string') return `vehicle: ${common}`;
  if (!isFiniteNumber(value.createdAt)) return `vehicle ${common.id}: createdAt is not a number`;

  const year = isFiniteNumber(value.year) ? Math.trunc(value.year) : 0;
  return {
    ...common,
    name: textOr(value.name, TEXT_LIMITS.name),
    make: textOr(value.make, TEXT_LIMITS.make),
    model: textOr(value.model, TEXT_LIMITS.model),
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
  if (!isFiniteNumber(value.date)) return `fill-up ${id}: date is not a number`;
  if (!isFiniteNumber(value.odometer)) return `fill-up ${id}: odometer is not a number`;
  if (!isFiniteNumber(value.gallons)) return `fill-up ${id}: gallons is not a number`;
  if (!isFiniteNumber(value.pricePerGallon)) return `fill-up ${id}: price is not a number`;
  return {
    date: value.date,
    odometer: value.odometer,
    gallons: value.gallons,
    pricePerGallon: value.pricePerGallon,
  };
}

export function validateFillUp(value: unknown): FillUpRecord | string {
  if (!isRecord(value)) return 'fill-up: not an object';
  const common = syncFields(value);
  if (typeof common === 'string') return `fill-up: ${common}`;
  if (typeof value.vehicleId !== 'string' || value.vehicleId === '') {
    return `fill-up ${common.id}: missing vehicleId`;
  }

  // A tombstone is a record that something was deleted. It carries no usable
  // measurements and does not need to — the same reasoning `importBackup`
  // applies when it skips the draft gate for one. It is built by
  // `tombstone.ts`, the one owner of the shape (#86): this used to build its
  // own, which kept `date`, so an older build's fat tombstone stayed half fat.
  if (common.deletedAt !== null) {
    return asTombstone(tombstoneFillUp, common, {
      vehicleId: value.vehicleId,
      enteredBy: enteredBy(value.enteredBy),
    } as Partial<FillUpRecord>);
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
    station: textOr(value.station, TEXT_LIMITS.station),
    notes: textOr(value.notes, TEXT_LIMITS.notes),
    latitude: coordinate(value.latitude),
    longitude: coordinate(value.longitude),
    receiptImageData: receipt(value.receiptImageData),
    enteredBy: enteredBy(value.enteredBy),
  };
}

/**
 * Who logged a fill-up (#66): a uid, or `null` for nobody known. Anything
 * implausible — absent (an older build), empty, not text, longer than any
 * uid — reads as nobody. Never a reason to drop the fill-up: the odometer
 * reading is what the statistics need, and the name is a courtesy.
 */
function enteredBy(value: unknown): string | null {
  return typeof value === 'string' && value !== '' && value.length <= TEXT_LIMITS.enteredBy ? value : null;
}

export function validatePending(value: unknown): PendingFillUpRecord | string {
  if (!isRecord(value)) return 'submission: not an object';
  const common = syncFields(value);
  if (typeof common === 'string') return `submission: ${common}`;
  if (typeof value.vehicleId !== 'string' || value.vehicleId === '') {
    return `submission ${common.id}: missing vehicleId`;
  }
  // A deleted submission has nothing to check either (#86): it used to need
  // measurements, so one written with none was refused on every pull.
  if (common.deletedAt !== null) {
    return asTombstone(tombstonePending, common, { vehicleId: value.vehicleId } as Partial<PendingFillUpRecord>);
  }
  if (!isFiniteNumber(value.submittedAt)) return `submission ${common.id}: submittedAt is not a number`;

  const numbers = measurements(value, common.id);
  if (typeof numbers === 'string') return numbers.replace('fill-up', 'submission');

  return {
    ...common,
    vehicleId: value.vehicleId,
    submittedAt: value.submittedAt,
    submitterName: textOr(value.submitterName, TEXT_LIMITS.submitterName),
    ...numbers,
    isFullTank: flag(value.isFullTank),
    fuelGrade: fuelGradeFromRaw(typeof value.fuelGrade === 'string' ? value.fuelGrade : ''),
    station: textOr(value.station, TEXT_LIMITS.station),
    notes: textOr(value.notes, TEXT_LIMITS.notes),
    latitude: coordinate(value.latitude),
    longitude: coordinate(value.longitude),
    receiptImageData: receipt(value.receiptImageData),
  };
}

/**
 * The tombstone `build` makes from what a tombstone keeps — its sync fields,
 * and `kept` — with the row's own stamp and deletion time rather than new ones.
 */
function asTombstone<T extends { readonly updatedAt: number; readonly deletedAt: number | null }>(
  build: (row: T, at: number) => T,
  common: {
    readonly id: string;
    readonly updatedAt: number;
    readonly deletedAt: number | null;
    readonly schemaVersion: number;
  },
  kept: Partial<T>,
): T {
  // The builders read only the fields a tombstone keeps, so the rest of `T`
  // need not exist here.
  const built = build({ ...common, ...kept } as unknown as T, common.updatedAt);
  return { ...built, updatedAt: common.updatedAt, deletedAt: common.deletedAt };
}

function partition<T>(rows: readonly unknown[], validate: (value: unknown) => T | string): Validated<T> {
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
  readonly snapshot: Snapshot;
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
