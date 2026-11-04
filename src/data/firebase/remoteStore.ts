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
  Timestamp,
  collection,
  doc,
  getDocsFromServer,
  getFirestore,
  query,
  serverTimestamp,
  where,
  writeBatch,
  type Firestore,
} from 'firebase/firestore';
import type { FillUpRecord, PendingFillUpRecord, Snapshot } from '../records';
import type { Collection, PullCursor, PushSummary, RawSnapshot, RemoteStore } from '../remote';
import { firebaseApp, type FirebaseSettings } from './config';

/**
 * The largest receipt that goes into a document, with headroom under the 1 MiB
 * cap for the rest of the row and Firestore's own overhead.
 */
export const MAX_SYNCED_RECEIPT_BYTES = 700 * 1024;

/** Firestore's batch limit. Larger histories are written in several batches. */
const BATCH_LIMIT = 500;

/**
 * A stamp as an exact integer count of microseconds, and back.
 *
 * Firestore keeps timestamps to the microsecond, so this is lossless — and it
 * has to be. The first version stored milliseconds as a float and read from a
 * millisecond below the cursor to be safe about rounding; against the emulator
 * that re-downloaded the newest document of every collection on every sync,
 * receipt and all, for ever. Exact integers compare exactly, so `>` the
 * cursor returns precisely what is new. About 1.8 × 10^15 today: well inside
 * `Number.MAX_SAFE_INTEGER`.
 */
export function toMicros(stamp: Timestamp): number {
  return stamp.seconds * 1_000_000 + Math.floor(stamp.nanoseconds / 1_000);
}

export function fromMicros(micros: number): Timestamp {
  const seconds = Math.floor(micros / 1_000_000);
  return new Timestamp(seconds, (micros - seconds * 1_000_000) * 1_000);
}

export class FirestoreRemoteStore implements RemoteStore {
  private readonly db: Firestore;

  constructor(
    settings: FirebaseSettings,
    private readonly uid: string,
    db?: Firestore,
  ) {
    this.db = db ?? getFirestore(firebaseApp(settings));
  }

  /**
   * Over a Firestore instance that already exists — the emulator's, in
   * `rules.test.ts`, so the real push and pull run against the real rules.
   */
  static over(db: Firestore, uid: string): FirestoreRemoteStore {
    return new FirestoreRemoteStore({ apiKey: '', authDomain: '', projectId: '', appId: '' }, uid, db);
  }

  /**
   * Everything the account holds, **as documents rather than as records**.
   *
   * The return type is deliberately `RawSnapshot` and not `Snapshot`:
   * what comes back is whatever is in the account, which may have been written
   * by a different build, half-written, or hand-edited in the console. Calling
   * it a typed record here would be the lie that lets it reach the statistics
   * layer unchecked. `syncOnce` validates it — see `recordValidation.ts`.
   */
  async pull(since: PullCursor | null = null): Promise<RawSnapshot> {
    const [vehicles, fillUps, pendingFillUps] = await Promise.all([
      this.read('vehicles', since?.vehicles ?? null),
      this.read('fillUps', since?.fillUps ?? null),
      this.read('pendingFillUps', since?.pendingFillUps ?? null),
    ]);
    return {
      vehicles: vehicles.rows,
      fillUps: fillUps.rows,
      pendingFillUps: pendingFillUps.rows,
      highWater: {
        vehicles: vehicles.highWater,
        fillUps: fillUps.highWater,
        pendingFillUps: pendingFillUps.highWater,
      },
    };
  }

  async push(snapshot: Snapshot): Promise<PushSummary> {
    let receiptsOmitted = 0;
    const writes: { readonly path: Collection; readonly id: string; readonly data: object }[] = [];

    for (const row of snapshot.vehicles) {
      writes.push({ path: 'vehicles', id: row.id, data: { ...row } });
    }
    // Every document is stamped with the server's commit time (#52), and the
    // rules refuse one that is not — that stamp is what an incremental read
    // asks for. A client-chosen time could sit below another device's cursor
    // and never be read, so it is the server's or nothing.
    for (const row of snapshot.fillUps) {
      const { data, omitted } = encodeReceipt(row);
      if (omitted) receiptsOmitted += 1;
      writes.push({ path: 'fillUps', id: row.id, data });
    }
    for (const row of snapshot.pendingFillUps) {
      const { data, omitted } = encodeReceipt(row);
      if (omitted) receiptsOmitted += 1;
      writes.push({ path: 'pendingFillUps', id: row.id, data });
    }

    for (let start = 0; start < writes.length; start += BATCH_LIMIT) {
      const batch = writeBatch(this.db);
      for (const write of writes.slice(start, start + BATCH_LIMIT)) {
        batch.set(doc(this.db, 'users', this.uid, write.path, write.id), {
          ...write.data,
          syncedAt: serverTimestamp(),
        });
      }
      await batch.commit();
    }

    return { written: writes.length, receiptsOmitted };
  }

  /**
   * Raw documents, with only the receipt bytes converted, and the newest stamp
   * among them.
   *
   * Every document when `since` is `null`; otherwise only those stamped after
   * it. A document with no stamp predates #52 and is only ever returned by a
   * full read — which every device does first, so none is missed.
   *
   * **From the server, never the cache.** The cursor claims "everything up to
   * here has been seen", and a cached result cannot back that claim; offline,
   * this fails, which sync reports as unreachable.
   */
  private async read(
    path: Collection,
    since: number | null,
  ): Promise<{ rows: Record<string, unknown>[]; highWater: number | null }> {
    const all = collection(this.db, 'users', this.uid, path);
    const target =
      since === null
        ? all
        : query(all, where('syncedAt', '>', fromMicros(since)));
    const snapshot = await getDocsFromServer(target);
    let highWater: number | null = null;
    const rows = snapshot.docs.map((document) => {
      const data = document.data();
      const stamp = data['syncedAt'];
      if (stamp instanceof Timestamp) highWater = Math.max(highWater ?? 0, toMicros(stamp));
      return decode(data);
    });
    return { rows, highWater };
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
export function decode(data: Record<string, unknown>): Record<string, unknown> {
  // The stamp is the remote's bookkeeping, not part of a record: it is read
  // above for the cursor and dropped here, so no record ever carries it.
  const { syncedAt: _stamp, ...rest } = data;
  const receipt = rest.receiptImageData;
  return {
    ...rest,
    receiptImageData: receipt instanceof Bytes ? receipt.toUint8Array() : null,
  };
}

/**
 * A fill-up or submission as it is written: the receipt as Firestore `Bytes`,
 * or dropped (and counted) when it is larger than one document can hold. The
 * shared-car remote writes fill-ups with this too (#66), so the two can never
 * disagree about what a row looks like on the wire.
 */
export function encodeReceipt(
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
