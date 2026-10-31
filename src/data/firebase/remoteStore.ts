/**
 * The account's copy of the data, in Firestore.
 *
 * The **only** file in the repository that imports `firebase/firestore`.
 *
 * ## Layout
 *
 * ```
 * users/{uid}/vehicles/{id}
 * users/{uid}/fillUps/{id}
 * users/{uid}/pendingFillUps/{id}
 * ```
 *
 * One document per row, under the owner's uid. Everything about this shape is
 * dictated by `firestore.rules`: a single `match /users/{uid}` prefix is what
 * lets one rule cover every collection, and a rule that simple is a rule that
 * can be read and verified. A flat top-level `fillUps` collection with an
 * `ownerId` field would need a rule per collection plus a query constraint, and
 * the classic way this category of app leaks everyone's data is a rule that was
 * one clause more complicated than its author could hold in their head.
 *
 * ## Tombstones are written, never deleted
 *
 * `deleteDoc` is never called. A deletion must exist as a fact to propagate: a
 * hard delete leaves nothing for a second device to learn from, so the row
 * simply reappears on the next push from whichever device still has it.
 *
 * ## Receipt photos
 *
 * Stored as a native Firestore `Bytes` value, not base64 — base64 inflates by a
 * third, and the binding limit here is the **1 MiB document cap**. Receipts are
 * already bounded at 1600px / quality 0.7 by `receiptImage.ts`, which usually
 * lands at 200–500 KB, but "usually" is not "always". A receipt over
 * `MAX_SYNCED_RECEIPT_BYTES` is pushed with the image omitted and counted in
 * `receiptsOmitted`, so the fill-up still syncs and the caller can say the photo
 * stayed behind. Silently truncating the bytes, or failing the whole sync over
 * one photo, are both worse.
 *
 * Cloud Storage would be the natural home for blobs, and is deliberately not
 * used: since 3 February 2026 it requires a linked billing account even at zero
 * usage, which would take this app off the free tier for the sake of an image.
 */

import {
  Bytes,
  collection,
  doc,
  getDocs,
  getFirestore,
  writeBatch,
  type Firestore,
} from 'firebase/firestore';
import type { BackupSnapshot } from '../../domain/backupFormat';
import type { FillUpRecord, PendingFillUpRecord } from '../records';
import type { PushSummary, RawSnapshot, RemoteStore } from '../remote';
import { firebaseApp, type FirebaseSettings } from './config';

/**
 * The largest receipt that goes into a document, with headroom under the 1 MiB
 * cap for the rest of the row and Firestore's own overhead.
 */
export const MAX_SYNCED_RECEIPT_BYTES = 700 * 1024;

/** Firestore's batch limit. Larger histories are written in several batches. */
const BATCH_LIMIT = 500;

type Collection = 'vehicles' | 'fillUps' | 'pendingFillUps';

export class FirestoreRemoteStore implements RemoteStore {
  private readonly db: Firestore;

  constructor(
    settings: FirebaseSettings,
    private readonly uid: string,
  ) {
    this.db = getFirestore(firebaseApp(settings));
  }

  /**
   * Everything the account holds, **as documents rather than as records**.
   *
   * The return type is deliberately `RawSnapshot` and not `BackupSnapshot`:
   * what comes back is whatever is in the account, which may have been written
   * by a different build, half-written, or hand-edited in the console. Calling
   * it a typed record here would be the lie that lets it reach the statistics
   * layer unchecked. `syncOnce` validates it — see `recordValidation.ts`.
   */
  async pull(): Promise<RawSnapshot> {
    const [vehicles, fillUps, pendingFillUps] = await Promise.all([
      this.read('vehicles'),
      this.read('fillUps'),
      this.read('pendingFillUps'),
    ]);
    return { vehicles, fillUps, pendingFillUps };
  }

  async push(snapshot: BackupSnapshot): Promise<PushSummary> {
    let receiptsOmitted = 0;
    const writes: { readonly path: Collection; readonly id: string; readonly data: object }[] = [];

    for (const row of snapshot.vehicles) {
      writes.push({ path: 'vehicles', id: row.id, data: { ...row } });
    }
    for (const row of snapshot.fillUps) {
      const { data, omitted } = this.encodeReceipt(row);
      if (omitted) receiptsOmitted += 1;
      writes.push({ path: 'fillUps', id: row.id, data });
    }
    for (const row of snapshot.pendingFillUps) {
      const { data, omitted } = this.encodeReceipt(row);
      if (omitted) receiptsOmitted += 1;
      writes.push({ path: 'pendingFillUps', id: row.id, data });
    }

    for (let start = 0; start < writes.length; start += BATCH_LIMIT) {
      const batch = writeBatch(this.db);
      for (const write of writes.slice(start, start + BATCH_LIMIT)) {
        batch.set(doc(this.db, 'users', this.uid, write.path, write.id), write.data);
      }
      await batch.commit();
    }

    return { written: writes.length, receiptsOmitted };
  }

  /** Raw documents, with only the receipt bytes converted. */
  private async read(path: Collection): Promise<Record<string, unknown>[]> {
    const snapshot = await getDocs(collection(this.db, 'users', this.uid, path));
    return snapshot.docs.map((document) => decode(document.data()));
  }

  private encodeReceipt(
    row: FillUpRecord | PendingFillUpRecord,
  ): { readonly data: object; readonly omitted: boolean } {
    const bytes = row.receiptImageData;
    if (bytes === null || bytes.byteLength === 0) {
      return { data: { ...row, receiptImageData: null }, omitted: false };
    }
    if (bytes.byteLength > MAX_SYNCED_RECEIPT_BYTES) {
      return { data: { ...row, receiptImageData: null }, omitted: true };
    }
    return { data: { ...row, receiptImageData: Bytes.fromUint8Array(bytes) }, omitted: false };
  }
}

/**
 * Converts the one field whose wire form differs from its in-memory form.
 *
 * Firestore hands back `Bytes`; the records hold `Uint8Array`. Everything else
 * is a number, string, boolean or null on both sides — and is *not* checked
 * here. Shape validation belongs to `recordValidation.ts`, which runs over the
 * result: keeping the two apart means the type conversion cannot quietly become
 * the place where validation is assumed to have happened.
 */
function decode(data: Record<string, unknown>): Record<string, unknown> {
  const receipt = data.receiptImageData;
  return {
    ...data,
    receiptImageData: receipt instanceof Bytes ? receipt.toUint8Array() : null,
  };
}
