import { describe, expect, test } from 'vitest';
import type { FillUpRecord, PendingFillUpRecord, VehicleRecord } from './records';
import {
  isScrubbed,
  tombstoneFillUp,
  tombstonePending,
  tombstoneVehicle,
} from './tombstone';

/**
 * What a deletion leaves behind.
 *
 * The rule under test: a tombstone keeps only what sync needs to reconcile it
 * — the four sync fields, plus `vehicleId` so a cascade can still be matched —
 * and carries none of the content. Issue #25: the old tombstone was
 * `{...row, deletedAt: now}`, which kept the receipt photograph, the notes and
 * the coordinates of a fill-up somebody had asked to delete.
 */

const VEHICLE: VehicleRecord = {
  id: 'v1',
  updatedAt: 100,
  deletedAt: null,
  schemaVersion: 1,
  name: 'Civic',
  make: 'Honda',
  model: 'Civic',
  year: 2019,
  createdAt: 50,
};

const FILL_UP: FillUpRecord = {
  id: 'f1',
  updatedAt: 100,
  deletedAt: null,
  schemaVersion: 1,
  vehicleId: 'v1',
  date: 1_700_000_000_000,
  odometer: 10_000,
  gallons: 10,
  pricePerGallon: 3.5,
  isFullTank: true,
  missedPreviousFillUp: true,
  fuelGrade: 'Premium',
  station: 'Shell, Market St',
  notes: 'topped up before the airport run',
  latitude: 37.79,
  longitude: -122.4,
  receiptImageData: new Uint8Array([1, 2, 3, 4]),
};

const PENDING: PendingFillUpRecord = {
  id: 'p1',
  updatedAt: 100,
  deletedAt: null,
  schemaVersion: 1,
  vehicleId: 'v1',
  submittedAt: 90,
  submitterName: 'Sam',
  date: 1_700_000_000_000,
  odometer: 10_000,
  gallons: 10,
  pricePerGallon: 3.5,
  isFullTank: true,
  fuelGrade: 'Regular',
  station: 'Shell',
  notes: 'filled it for you',
  latitude: 37.79,
  longitude: -122.4,
  receiptImageData: new Uint8Array([9, 9]),
};

describe('a fill-up tombstone', () => {
  const dead = tombstoneFillUp(FILL_UP, 500);

  test('keeps what sync needs and nothing else', () => {
    expect(dead.id).toBe('f1');
    expect(dead.vehicleId).toBe('v1');
    expect(dead.deletedAt).toBe(500);
    expect(dead.updatedAt).toBe(500);
    expect(dead.schemaVersion).toBe(1);
  });

  test('keeps no receipt photograph', () => {
    // The one that matters most. A receipt shows where somebody physically
    // was, and often part of a card number.
    expect(dead.receiptImageData).toBeNull();
  });

  test('keeps no free text', () => {
    expect(dead.station).toBe('');
    expect(dead.notes).toBe('');
  });

  test('keeps no coordinates', () => {
    expect(dead.latitude).toBeNull();
    expect(dead.longitude).toBeNull();
  });

  test('keeps no measurements, and not the date either', () => {
    // The date alone says somebody bought fuel that day. Sync does not need
    // it, so it does not survive.
    expect(dead.date).toBe(0);
    expect(dead.odometer).toBe(0);
    expect(dead.gallons).toBe(0);
    expect(dead.pricePerGallon).toBe(0);
    expect(dead.isFullTank).toBe(false);
    expect(dead.missedPreviousFillUp).toBe(false);
  });

  test('is the same shape recordValidation already builds for an incoming one', () => {
    // `validateFillUp` zeroes a tombstone's fields and falls its grade back to
    // `Other`. That was already the reader's assumption; this is the writer
    // finally agreeing with it.
    expect(dead.fuelGrade).toBe('Other');
  });

  test('still carries every field, because the rules demand all of them', () => {
    // `hasOnly` plus `hasAll` in firestore.rules means a document must have
    // exactly the known keys. Emptying values is allowed; dropping keys is not.
    expect(Object.keys(dead).sort()).toEqual(Object.keys(FILL_UP).sort());
  });

  test('does not mutate the row it was given', () => {
    expect(FILL_UP.receiptImageData).not.toBeNull();
    expect(FILL_UP.notes).not.toBe('');
  });
});

describe('a vehicle tombstone', () => {
  const dead = tombstoneVehicle(VEHICLE, 500);

  test('keeps the sync fields and drops the description', () => {
    expect(dead.id).toBe('v1');
    expect(dead.deletedAt).toBe(500);
    expect(dead.name).toBe('');
    expect(dead.make).toBe('');
    expect(dead.model).toBe('');
    expect(dead.year).toBe(0);
    expect(dead.createdAt).toBe(0);
  });

  test('still carries every field', () => {
    expect(Object.keys(dead).sort()).toEqual(Object.keys(VEHICLE).sort());
  });
});

describe('a submission tombstone', () => {
  const dead = tombstonePending(PENDING, 500);

  test('drops the submitter, who is somebody else', () => {
    // A rejected submission is the one record here written by a third party.
    // Keeping their name and their note after a rejection would be the worst
    // version of this bug.
    expect(dead.submitterName).toBe('');
    expect(dead.notes).toBe('');
    expect(dead.submittedAt).toBe(0);
    expect(dead.receiptImageData).toBeNull();
  });

  test('still carries every field', () => {
    expect(Object.keys(dead).sort()).toEqual(Object.keys(PENDING).sort());
  });
});

describe('isScrubbed', () => {
  test('recognises a tombstone this build would write', () => {
    expect(isScrubbed(tombstoneFillUp(FILL_UP, 500), tombstoneFillUp)).toBe(true);
  });

  test('recognises a fat tombstone from an older build', () => {
    // How the one-time cleanup finds what to fix: a row written the old way,
    // `{...row, deletedAt}`.
    const legacy: FillUpRecord = { ...FILL_UP, deletedAt: 500, updatedAt: 500 };
    expect(isScrubbed(legacy, tombstoneFillUp)).toBe(false);
  });

  test('notices a receipt even when everything else is already empty', () => {
    const almost: FillUpRecord = {
      ...tombstoneFillUp(FILL_UP, 500),
      receiptImageData: new Uint8Array([1]),
    };
    expect(isScrubbed(almost, tombstoneFillUp)).toBe(false);
  });

  test('ignores the timestamp, which legitimately differs', () => {
    // `updatedAt` is bumped when a legacy tombstone is rewritten, so comparing
    // it would report every scrubbed row as still dirty and rewrite it on
    // every load — a write loop, and a sync loop behind it.
    const dead = tombstoneFillUp(FILL_UP, 500);
    expect(isScrubbed({ ...dead, updatedAt: 9_999 }, tombstoneFillUp)).toBe(true);
  });

  test('works for the other two record types', () => {
    expect(isScrubbed(tombstoneVehicle(VEHICLE, 1), tombstoneVehicle)).toBe(true);
    expect(isScrubbed({ ...VEHICLE, deletedAt: 1 }, tombstoneVehicle)).toBe(false);
    expect(isScrubbed(tombstonePending(PENDING, 1), tombstonePending)).toBe(true);
    expect(isScrubbed({ ...PENDING, deletedAt: 1 }, tombstonePending)).toBe(false);
  });
});
