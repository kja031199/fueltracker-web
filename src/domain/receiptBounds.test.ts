import { describe, expect, it } from 'vitest';
import { MAX_RECEIPT_BYTES } from './fuelEntryDraft';
import { base64ToBytes, bytesToBase64, parseJsonBackup, toJsonBackup } from './backupFormat';

/**
 * The receipt size bound, on the paths that were not applying it.
 *
 * `fuelEntryDraft` drops a receipt over `MAX_RECEIPT_BYTES`, and every normal
 * write goes through it. The import path did not: `importBackup` builds a draft
 * to validate the *numbers* and then stores the incoming row, and the draft is
 * never handed `receiptImageData` — so a backup file could carry an
 * arbitrarily large photo straight into IndexedDB, decoded in full first.
 *
 * "An import file is untrusted input" is this project's own stated posture.
 * These are the assertions that make it true for receipts.
 */

/** Base64 for `n` bytes, without allocating `n` bytes to find out its length. */
function base64OfLength(byteLength: number): string {
  const groups = Math.ceil(byteLength / 3);
  return 'A'.repeat(groups * 4);
}

describe('base64ToBytes', () => {
  it('decodes a small payload', () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it('returns null for text that is not base64', () => {
    expect(base64ToBytes('not base64 !!!')).toBeNull();
  });

  it('refuses a payload beyond the given bound', () => {
    expect(base64ToBytes(base64OfLength(2000), 1000)).toBeNull();
  });

  it('accepts a payload exactly at the bound', () => {
    const bytes = new Uint8Array(300);
    expect(base64ToBytes(bytesToBase64(bytes), 300)).toEqual(bytes);
  });

  it('refuses without decoding the payload first', () => {
    // The point of the bound. Deciding after `atob` means the allocation has
    // already happened, which is the thing being defended against — so the
    // refusal has to be derivable from the text length alone.
    //
    // 400 MB of base64 is ~300 MB of bytes. If this decodes before refusing,
    // the test machine feels it; if the bound is checked first, it is instant.
    const huge = base64OfLength(300 * 1024 * 1024);
    const started = Date.now();
    expect(base64ToBytes(huge, MAX_RECEIPT_BYTES)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('is unbounded when no bound is given, so existing callers are unchanged', () => {
    const bytes = new Uint8Array(5000);
    expect(base64ToBytes(bytesToBase64(bytes))).toHaveLength(5000);
  });
});

describe('a backup file carrying an oversized receipt', () => {
  /** A backup whose single fill-up claims a receipt of `byteLength` bytes. */
  function fileWithReceipt(byteLength: number): string {
    const snapshot = {
      vehicles: [
        {
          id: 'v1',
          updatedAt: 100,
          deletedAt: null,
          schemaVersion: 1,
          name: 'Civic',
          make: 'Honda',
          model: 'Civic',
          year: 2019,
          createdAt: 100,
        },
      ],
      fillUps: [
        {
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
          missedPreviousFillUp: false,
          fuelGrade: 'Regular' as const,
          station: 'Shell',
          notes: '',
          latitude: null,
          longitude: null,
          receiptImageData: new Uint8Array(byteLength),
        },
      ],
      pendingFillUps: [],
    };
    return toJsonBackup(snapshot);
  }

  it('keeps the fill-up and drops only the photo', () => {
    // The row carries an odometer reading the whole MPG chain depends on.
    // Rejecting it because its photo was too big would be the worse outcome —
    // the same repair-rather-than-reject split `recordValidation` applies.
    const parsed = parseJsonBackup(fileWithReceipt(MAX_RECEIPT_BYTES + 1));

    expect(parsed.error).toBeNull();
    expect(parsed.value?.fillUps).toHaveLength(1);
    expect(parsed.value?.fillUps[0]?.odometer).toBe(10_000);
    expect(parsed.value?.fillUps[0]?.receiptImageData).toBeNull();
  });

  it('says that it dropped one, rather than doing it silently', () => {
    const parsed = parseJsonBackup(fileWithReceipt(MAX_RECEIPT_BYTES + 1));
    expect(parsed.skipped.join(' ')).toMatch(/receipt/i);
  });

  it('keeps a receipt that is within the bound', () => {
    const parsed = parseJsonBackup(fileWithReceipt(1024));
    expect(parsed.value?.fillUps[0]?.receiptImageData).toHaveLength(1024);
    expect(parsed.skipped).toEqual([]);
  });

  it('keeps a receipt of exactly the maximum size', () => {
    const parsed = parseJsonBackup(fileWithReceipt(MAX_RECEIPT_BYTES));
    expect(parsed.value?.fillUps[0]?.receiptImageData).toHaveLength(MAX_RECEIPT_BYTES);
    expect(parsed.skipped).toEqual([]);
  });

  it('drops a receipt that is not valid base64 without losing the row', () => {
    const file = JSON.parse(fileWithReceipt(16)) as Record<string, unknown>;
    const fillUps = file.fillUps as Record<string, unknown>[];
    fillUps[0]!.receiptImageData = 'this is not base64 @@@@';

    const parsed = parseJsonBackup(JSON.stringify(file));

    expect(parsed.value?.fillUps).toHaveLength(1);
    expect(parsed.value?.fillUps[0]?.receiptImageData).toBeNull();
  });

  it('applies the same bound to a submission', () => {
    // pendingFillUps take the same decode path, and approval re-validates the
    // numbers but not the photo.
    const file = JSON.parse(fileWithReceipt(16)) as Record<string, unknown>;
    const oversized = bytesToBase64(new Uint8Array(MAX_RECEIPT_BYTES + 1));
    file.pendingFillUps = [
      {
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
        station: '',
        notes: '',
        latitude: null,
        longitude: null,
        receiptImageData: oversized,
      },
    ];

    const parsed = parseJsonBackup(JSON.stringify(file));

    expect(parsed.value?.pendingFillUps).toHaveLength(1);
    expect(parsed.value?.pendingFillUps[0]?.receiptImageData).toBeNull();
  });
});
