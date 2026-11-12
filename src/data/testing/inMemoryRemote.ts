/**
 * The account, in memory, for tests (#96: moved out of `remote.ts`, where it
 * made a production module twice as long for code production never runs).
 *
 * @trap #8 — Tests never touch the network or a real device service:
 * `StubAuthProvider` and the fakes in this folder exist for that.
 *
 * @trap #96 — A fake reads the way the real one does, or the tests prove a
 * different program: the scoped pull returns the car's document on every pull,
 * with a cursor of its own (`pullCar`), as `FirestoreScopedRemote.pull` does.
 * Change a real remote's reads, change its fake, and pin the difference in
 * `sharing.test.ts`. The only `InMemory*` classes in production code are
 * `InMemoryRepository` and `InMemorySyncState`.
 */

import type { SyncFields, Snapshot } from '../records';
import type { Collection, PullCursor, PushSummary, RawSnapshot, RemoteStore } from '../remote';
import { emptySnapshot } from '../remote';

/**
 * A `RemoteStore` backed by plain `Map`s.
 *
 * Replaces by id and keeps tombstones, exactly as Firestore does, so a test
 * that pushes then pulls sees what the real thing would return.
 *
 * It also stamps like Firestore (#52): every pushed row gets a server time,
 * strictly increasing per push, and a pull with a cursor returns only rows
 * stamped after it. A **seeded** row has no stamp — it stands for a document
 * written before stamps existed — so only a full read returns it, which is
 * exactly the real migration case.
 */
export class InMemoryRemoteStore implements RemoteStore {
  private readonly vehicles = new Map<string, Snapshot['vehicles'][number]>();
  private readonly fillUps = new Map<string, Snapshot['fillUps'][number]>();
  private readonly pendingFillUps = new Map<string, Snapshot['pendingFillUps'][number]>();
  /** `collection/id` → the server time of the last push that wrote it. */
  private readonly stamps = new Map<string, number>();
  private serverTime = 0;

  /** Set to make `pull()` reject, standing in for being offline. */
  failPull = false;
  /** Set to make `push()` reject, standing in for a write that is refused. */
  failPush = false;
  /** Bound above which a receipt is dropped, mirroring the document cap. */
  receiptByteLimit = Number.POSITIVE_INFINITY;
  /** Every pull: the cursor it was given and how many rows it returned. */
  readonly pullLog: { readonly since: PullCursor | null; readonly rows: number }[] = [];

  constructor(seed: Snapshot = emptySnapshot()) {
    for (const row of seed.vehicles) this.vehicles.set(row.id, row);
    for (const row of seed.fillUps) this.fillUps.set(row.id, row);
    for (const row of seed.pendingFillUps) this.pendingFillUps.set(row.id, row);
  }

  /** Whether this tree holds a vehicle document with that id, live or a tombstone. */
  hasVehicle(id: string): boolean {
    return this.vehicles.has(id);
  }

  async pull(since: PullCursor | null = null): Promise<RawSnapshot> {
    if (this.failPull) throw new Error('offline');
    const vehicles = this.read('vehicles', this.vehicles, since);
    const fillUps = this.read('fillUps', this.fillUps, since);
    const pendingFillUps = this.read('pendingFillUps', this.pendingFillUps, since);
    this.pullLog.push({
      since,
      rows: vehicles.rows.length + fillUps.rows.length + pendingFillUps.rows.length,
    });
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
    if (this.failPush) throw new Error('write refused');
    // One batch, one commit time — as a Firestore `writeBatch` stamps it.
    const at = ++this.serverTime;
    let written = 0;
    let receiptsOmitted = 0;
    for (const row of snapshot.vehicles) {
      this.vehicles.set(row.id, row);
      this.stamps.set(`vehicles/${row.id}`, at);
      written += 1;
    }
    for (const row of snapshot.fillUps) {
      const bytes = row.receiptImageData;
      if (bytes !== null && bytes.byteLength > this.receiptByteLimit) {
        this.fillUps.set(row.id, { ...row, receiptImageData: null });
        receiptsOmitted += 1;
      } else {
        this.fillUps.set(row.id, row);
      }
      this.stamps.set(`fillUps/${row.id}`, at);
      written += 1;
    }
    for (const row of snapshot.pendingFillUps) {
      this.pendingFillUps.set(row.id, row);
      this.stamps.set(`pendingFillUps/${row.id}`, at);
      written += 1;
    }
    return { written, receiptsOmitted };
  }

  /**
   * One car as a member reads it, the way `FirestoreScopedRemote.pull` does
   * (#96): the car's document whole on every pull — live, a tombstone, or
   * nothing if it is gone outright — and that car's fill-ups stamped after
   * the cursor's fill-up mark. The cursor it hands back is the car's own:
   * no vehicle mark, since the car is always read whole, and the newest stamp
   * among *this car's* fill-ups, never the account's.
   */
  pullCar(vehicleId: string, since: PullCursor | null = null): RawSnapshot {
    if (this.failPull) throw new Error('offline');
    const car = this.vehicles.get(vehicleId);
    const fillUps = this.read('fillUps', this.fillUps, since, (row) => row.vehicleId === vehicleId);
    const vehicles = car === undefined ? [] : [car];
    this.pullLog.push({ since, rows: vehicles.length + fillUps.rows.length });
    return {
      vehicles,
      fillUps: fillUps.rows,
      pendingFillUps: [],
      highWater: { vehicles: null, fillUps: fillUps.highWater, pendingFillUps: null },
    };
  }

  /** Deletes a document outright, as a hand edit in the console would. */
  forget(collection: Collection, id: string): void {
    this[collection].delete(id);
    this.stamps.delete(`${collection}/${id}`);
  }

  private read<T extends SyncFields>(
    name: Collection,
    rows: Map<string, T>,
    since: PullCursor | null,
    which: (row: T) => boolean = () => true,
  ): { rows: T[]; highWater: number | null } {
    const mark = since === null ? null : since[name];
    let highWater: number | null = null;
    const out: T[] = [];
    for (const row of rows.values()) {
      if (!which(row)) continue;
      const stamp = this.stamps.get(`${name}/${row.id}`);
      if (mark !== null && (stamp === undefined || stamp <= mark)) continue;
      out.push(row);
      if (stamp !== undefined) highWater = Math.max(highWater ?? stamp, stamp);
    }
    return { rows: out, highWater };
  }
}
