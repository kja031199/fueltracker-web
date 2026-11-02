import { describe, expect, it } from 'vitest';
import { InMemoryRepository } from './repository';
import { InMemoryRemoteStore, emptySnapshot, rowsToPush, sendableRows } from './remote';
import type { RawSnapshot, RemoteStore } from './remote';
import { FuelTrackerStore } from './store';
import { MonotonicClock } from './syncClock';
import { SCHEMA_VERSION, type FillUpRecord, type VehicleRecord } from './records';
import { validateSnapshot } from './recordValidation';
import { isRefusal, partitionBySchema, preserveLocalReceipts, syncOnce } from './sync';
import { InMemorySyncState } from './syncState';
import { makeFuelEntryDraft } from '../domain/fuelEntryDraft';
import type { Snapshot } from './records';

/**
 * A monotonic clock over a wall clock the test controls.
 *
 * Deterministic ids and a wall clock that advances a millisecond per read, so
 * assertions do not depend on real time. It is a real `MonotonicClock` rather
 * than a stub because the skew behaviour under test lives in that class.
 */
function fakeClock(start = 1_000_000): MonotonicClock {
  let wall = start;
  let n = 0;
  return new MonotonicClock(
    () => (wall += 1),
    () => `id-${++n}`,
  );
}

function storeWith(clock: MonotonicClock = fakeClock()) {
  const r = {
    vehicles: new InMemoryRepository<VehicleRecord>(),
    fillUps: new InMemoryRepository<FillUpRecord>(),
    pendingFillUps: new InMemoryRepository<import('./records').PendingFillUpRecord>(),
  };
  // The clock is returned so a test can hand the *same* instance to
  // `syncOnce`. Sharing it is the point: the store issues local timestamps and
  // sync observes remote ones, and a device only outbids a fast clock if those
  // are the same clock.
  return { store: new FuelTrackerStore(r, clock), repos: r, clock };
}

function vehicle(overrides: Partial<VehicleRecord> = {}): VehicleRecord {
  return {
    id: 'v1',
    updatedAt: 100,
    deletedAt: null,
    schemaVersion: SCHEMA_VERSION,
    name: 'Civic',
    make: 'Honda',
    model: 'Civic',
    year: 2019,
    createdAt: 100,
    ...overrides,
  };
}

function fillUp(overrides: Partial<FillUpRecord> = {}): FillUpRecord {
  return {
    id: 'f1',
    updatedAt: 100,
    deletedAt: null,
    schemaVersion: SCHEMA_VERSION,
    vehicleId: 'v1',
    date: 1_700_000_000_000,
    odometer: 10_000,
    gallons: 10,
    pricePerGallon: 3.5,
    isFullTank: true,
    missedPreviousFillUp: false,
    fuelGrade: 'Regular',
    station: 'Shell',
    notes: '',
    latitude: null,
    longitude: null,
    receiptImageData: null,
    ...overrides,
  };
}

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return { ...emptySnapshot(), ...overrides };
}

/**
 * Reads the remote back as typed records.
 *
 * `pull()` returns `RawSnapshot` — `unknown[]` — because the account's contents
 * are not something a remote can vouch for. Tests that want to assert on a
 * field have to validate first, same as the app does, which means these
 * assertions exercise the validator rather than bypassing it.
 */
async function pulled(remote: InMemoryRemoteStore): Promise<Snapshot> {
  return validateSnapshot(await remote.pull()).snapshot;
}

describe('rowsToPush', () => {
  it('sends a row the remote has never seen', () => {
    expect(rowsToPush([vehicle()], [])).toHaveLength(1);
  });

  it('sends a row the remote holds an older copy of', () => {
    const pushed = rowsToPush([vehicle({ updatedAt: 200 })], [vehicle({ updatedAt: 100 })]);
    expect(pushed).toHaveLength(1);
  });

  it('spends no write when both sides already agree', () => {
    // Equal, not greater. Re-writing an identical row would burn a quota write
    // to change nothing, and the free tier's daily write budget is the thing
    // that runs out first.
    expect(rowsToPush([vehicle({ updatedAt: 100 })], [vehicle({ updatedAt: 100 })])).toEqual([]);
  });

  it('does not send a row the remote holds a newer copy of', () => {
    expect(rowsToPush([vehicle({ updatedAt: 100 })], [vehicle({ updatedAt: 200 })])).toEqual([]);
  });
});

describe('partitionBySchema', () => {
  it('keeps rows this build understands', () => {
    const { readable, tooNew } = partitionBySchema([vehicle()]);
    expect(readable).toHaveLength(1);
    expect(tooNew).toEqual([]);
  });

  it('sets aside a row written by a newer version', () => {
    // Reading it optimistically and pushing it back is how a downgrade
    // silently strips fields this build does not know about.
    const { readable, tooNew } = partitionBySchema([vehicle({ schemaVersion: 99 })]);
    expect(readable).toEqual([]);
    expect(tooNew).toHaveLength(1);
  });
});

describe('preserveLocalReceipts', () => {
  const bytes = new Uint8Array([1, 2, 3]);

  it('keeps a local photo when the incoming row has none', () => {
    const merged = preserveLocalReceipts(
      [fillUp({ receiptImageData: null, updatedAt: 500 })],
      [fillUp({ receiptImageData: bytes })],
    );
    expect(merged[0]?.receiptImageData).toEqual(bytes);
  });

  it('prefers the incoming photo when there is one', () => {
    const incoming = new Uint8Array([9]);
    const merged = preserveLocalReceipts(
      [fillUp({ receiptImageData: incoming })],
      [fillUp({ receiptImageData: bytes })],
    );
    expect(merged[0]?.receiptImageData).toEqual(incoming);
  });

  it('leaves a row alone when neither side has a photo', () => {
    const merged = preserveLocalReceipts([fillUp()], [fillUp()]);
    expect(merged[0]?.receiptImageData).toBeNull();
  });

  it('does not invent a photo for a row that is only remote', () => {
    const merged = preserveLocalReceipts([fillUp({ id: 'other' })], [fillUp({ receiptImageData: bytes })]);
    expect(merged[0]?.receiptImageData).toBeNull();
  });

  it('does not re-attach a photo to a tombstone', () => {
    // Issue #25. A tombstone now carries no receipt deliberately, and the
    // local copy of that same row still has one until it is scrubbed — so the
    // "an incoming row never *removes* a receipt" rule, applied to a deletion,
    // would put the photo straight back onto the row that was deleted to be
    // rid of it. The exception is narrow and only for tombstones: a live row
    // arriving without a photo still keeps the local one.
    const merged = preserveLocalReceipts(
      [fillUp({ receiptImageData: null, deletedAt: 900, updatedAt: 900 })],
      [fillUp({ receiptImageData: bytes })],
    );
    expect(merged[0]?.receiptImageData).toBeNull();
  });
});

describe('erasing a tombstone that is already in the account', () => {
  it('pushes the scrubbed row over the fat one', async () => {
    // The only way the remote copy is ever erased: rewriting the row locally
    // bumps `updatedAt`, so the next sync pushes the thin version over the
    // document that still holds the photograph.
    const fat = fillUp({
      deletedAt: 500,
      updatedAt: 500,
      station: 'Shell, Market St',
      notes: 'before the airport run',
      receiptImageData: new Uint8Array([1, 2, 3]),
    });
    const clock = fakeClock();
    const repos = {
      vehicles: new InMemoryRepository<VehicleRecord>(),
      fillUps: new InMemoryRepository<FillUpRecord>([fat]),
      pendingFillUps: new InMemoryRepository<import('./records').PendingFillUpRecord>(),
    };
    const store = new FuelTrackerStore(repos, clock);
    const remote = new InMemoryRemoteStore({
      ...emptySnapshot(),
      fillUps: [fat],
    });

    expect(await store.scrubTombstones()).toBe(1);
    const result = await syncOnce(store, remote, clock);
    expect(result.ok).toBe(true);

    const after = await remote.pull();
    const row = after.fillUps[0] as FillUpRecord;
    expect(row.deletedAt).not.toBeNull();
    expect(row.receiptImageData).toBeNull();
    expect(row.station).toBe('');
    expect(row.notes).toBe('');
  });
});

describe('a refusal is not the same as being unreachable', () => {
  /**
   * Issue #40. Every sync failure used to be reported as "Could not reach your
   * account", with the real cause in brackets — so a `permission-denied` from
   * the security rules read as a network problem. Two different situations,
   * two different remedies, and the headline named the wrong one.
   *
   * Since the allowlist in #27 this is routine rather than a bug: it is
   * exactly what a signed-in account that is not on the list sees, and nothing
   * it does about its wifi will change anything.
   */

  /** A remote that refuses, the way Firestore does: a coded error object. */
  class RefusingRemote implements RemoteStore {
    constructor(private readonly where: 'pull' | 'push') {}

    async pull(): Promise<RawSnapshot> {
      if (this.where === 'pull') throw refusal();
      return { vehicles: [], fillUps: [], pendingFillUps: [] };
    }

    async push(): Promise<import('./remote').PushSummary> {
      if (this.where === 'push') throw refusal();
      return { written: 0, receiptsOmitted: 0 };
    }
  }

  /** Shaped like a FirebaseError, built by hand: no SDK in this suite. */
  function refusal(): unknown {
    const error = new Error('Missing or insufficient permissions.');
    (error as unknown as Record<string, unknown>)['code'] = 'permission-denied';
    return error;
  }

  it('reports a refused pull as refused, not as unreachable', async () => {
    const { store, clock } = storeWith();
    const result = await syncOnce(store, new RefusingRemote('pull'), clock);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('refused');
    expect(result.reason).not.toMatch(/could not reach/i);
    expect(result.reason).toMatch(/access/i);
  });

  it('reports a refused push as rejected changes, not as a refused account', async () => {
    // Changed in #50; this test used to assert the opposite. A push is refused
    // only *after* a pull succeeded — and a pull succeeding proves the account
    // is allowed. What was refused is the data, not the person: one over-long
    // station name used to put an allowed owner on the no-access screen, with
    // no way to reach the row that caused it.
    const { store, clock } = storeWith();
    await store.addVehicle({ name: 'Civic' });

    const result = await syncOnce(store, new RefusingRemote('push'), clock);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('rejected');
    expect(result.reason).not.toMatch(/does not have access/i);
    expect(result.reason).toMatch(/saved on this device/i);
  });

  it('tells a refused reader where to find the id that fixes it', async () => {
    // The remedy is specific: send your account id to whoever runs this copy.
    // A message that does not say that leaves the one actionable fact out.
    const { store, clock } = storeWith();
    const result = await syncOnce(store, new RefusingRemote('pull'), clock);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.reason).toMatch(/account id/i);
  });

  it('still reports an ordinary network failure as unreachable', async () => {
    // The distinction has to cut both ways, or it is just a reworded message.
    const { store, clock } = storeWith();
    const remote = new InMemoryRemoteStore();
    remote.failPull = true;

    const result = await syncOnce(store, remote, clock);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('unreachable');
    expect(result.reason).toMatch(/could not reach your account/i);
  });

  it('still reports an ordinary failed upload as unreachable', async () => {
    const { store, clock } = storeWith();
    await store.addVehicle({ name: 'Civic' });
    const remote = new InMemoryRemoteStore();
    remote.failPush = true;

    const result = await syncOnce(store, remote, clock);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('unreachable');
    expect(result.reason).toMatch(/not uploaded yet/i);
  });
});

describe('isRefusal', () => {
  it('recognises the code Firestore uses', () => {
    const error = new Error('nope');
    (error as unknown as Record<string, unknown>)['code'] = 'permission-denied';
    expect(isRefusal(error)).toBe(true);
  });

  it('recognises it on a plain object, since the shape is what is checked', () => {
    // Read structurally on purpose: importing `FirestoreError` would pull the
    // Firebase SDK into `sync.ts` and break invariant 6, which is what keeps
    // this suite runnable with no SDK and no emulator.
    expect(isRefusal({ code: 'permission-denied' })).toBe(true);
  });

  it.each([
    ['nothing', undefined],
    ['null', null],
    ['a bare error', new Error('offline')],
    ['another code', { code: 'unavailable' }],
    ['a string', 'permission-denied'],
    ['a number', 7],
    ['a nested code', { error: { code: 'permission-denied' } }],
  ])('does not mistake %s for a refusal', (_label, value) => {
    expect(isRefusal(value)).toBe(false);
  });
});

describe('a local row the account cannot address', () => {
  /**
   * Issue #26, the containment half. Validation now refuses an unstorable id
   * at every door, but a row stored *before* that fix is already on disk — and
   * it is strictly newer than anything remote, so it is in every push, and one
   * `writeBatch` throwing takes the whole upload with it. Every sync, forever,
   * reported as the ordinary "not uploaded yet". Deleting the fill-up does not
   * help: the tombstone carries the same id.
   */

  /** Behaves like Firestore: it will not address a document named `a/b`. */
  class StrictRemoteStore extends InMemoryRemoteStore {
    override async push(snapshot: Snapshot): Promise<import('./remote').PushSummary> {
      for (const row of [
        ...snapshot.vehicles,
        ...snapshot.fillUps,
        ...snapshot.pendingFillUps,
      ]) {
        if (row.id.includes('/')) {
          throw new Error(
            `Invalid document reference. Document references must have an even number of segments, but users/u1/fillUps/${row.id} has 5.`,
          );
        }
      }
      return super.push(snapshot);
    }
  }

  function storeHolding(rows: readonly FillUpRecord[]) {
    const clock = fakeClock();
    const repos = {
      vehicles: new InMemoryRepository<VehicleRecord>([vehicle()]),
      fillUps: new InMemoryRepository<FillUpRecord>(rows),
      pendingFillUps: new InMemoryRepository<import('./records').PendingFillUpRecord>(),
    };
    return { store: new FuelTrackerStore(repos, clock), clock };
  }

  it('does not take the rest of the upload down with it', async () => {
    const { store, clock } = storeHolding([
      fillUp({ id: 'good', updatedAt: 900 }),
      fillUp({ id: 'a/b', updatedAt: 900 }),
    ]);
    const remote = new StrictRemoteStore();

    const result = await syncOnce(store, remote, clock);

    expect(result.ok).toBe(true);
    const after = await remote.pull();
    expect((after.fillUps as FillUpRecord[]).map((row) => row.id)).toEqual(['good']);
    expect((after.vehicles as VehicleRecord[])).toHaveLength(1);
  });

  it('reports the row rather than dropping it quietly', async () => {
    const { store, clock } = storeHolding([fillUp({ id: 'a/b', updatedAt: 900 })]);

    const result = await syncOnce(store, new StrictRemoteStore(), clock);

    if (!result.ok) throw new Error(result.reason);
    expect(result.outcome.unsendable).toEqual(['a/b']);
  });

  it('leaves the row alone locally, because it is not ours to delete', async () => {
    // Refusing to upload something is not a licence to destroy it. The row
    // stays readable here; the reader is told, and can export or fix it.
    const { store, clock } = storeHolding([fillUp({ id: 'a/b', updatedAt: 900 })]);
    await syncOnce(store, new StrictRemoteStore(), clock);
    const local = await store.exportSnapshot();
    expect(local.fillUps.map((row) => row.id)).toEqual(['a/b']);
  });

  it('says nothing when every id is fine', async () => {
    const { store, clock } = storeHolding([fillUp({ id: 'good', updatedAt: 900 })]);
    const result = await syncOnce(store, new StrictRemoteStore(), clock);
    if (!result.ok) throw new Error(result.reason);
    expect(result.outcome.unsendable).toEqual([]);
  });
});

describe('syncOnce', () => {
  it('pulls a remote row that is missing locally', async () => {
    const { store } = storeWith();
    const remote = new InMemoryRemoteStore(snapshot({ vehicles: [vehicle()], fillUps: [fillUp()] }));

    const result = await syncOnce(store, remote, fakeClock());

    expect(result.ok).toBe(true);
    expect(await store.vehicles()).toHaveLength(1);
    expect(await store.fillUps('v1')).toHaveLength(1);
  });

  it('pushes a local row the account has never seen', async () => {
    const { store } = storeWith();
    await store.addVehicle({ name: 'Civic' });
    const remote = new InMemoryRemoteStore();

    const result = await syncOnce(store, remote, fakeClock());

    expect(result.ok).toBe(true);
    expect((await pulled(remote)).vehicles).toHaveLength(1);
  });

  it('is a no-op the second time', async () => {
    const { store } = storeWith();
    await store.addVehicle({ name: 'Civic' });
    const remote = new InMemoryRemoteStore();

    await syncOnce(store, remote, fakeClock());
    const second = await syncOnce(store, remote, fakeClock());

    // Nothing left to write, because both sides agree on every updatedAt.
    expect(second.ok && second.outcome.pushed.written).toBe(0);
  });

  it('lets the newer edit win regardless of which side it is on', async () => {
    const { store, repos: r } = storeWith();
    await r.vehicles.put(vehicle({ name: 'Local name', updatedAt: 300 }));
    const remote = new InMemoryRemoteStore(
      snapshot({ vehicles: [vehicle({ name: 'Remote name', updatedAt: 200 })] }),
    );

    await syncOnce(store, remote, fakeClock());

    const [stored] = await store.vehicles();
    expect(stored?.name).toBe('Local name');
    expect((await pulled(remote)).vehicles[0]?.name).toBe('Local name');
  });

  it('propagates a remote tombstone into local storage', async () => {
    const { store, repos: r } = storeWith();
    await r.vehicles.put(vehicle({ updatedAt: 100 }));
    const remote = new InMemoryRemoteStore(
      snapshot({ vehicles: [vehicle({ updatedAt: 200, deletedAt: 200 })] }),
    );

    await syncOnce(store, remote, fakeClock());

    // A deletion has to travel as a fact; a hard delete would leave nothing to
    // learn from and the row would come back on the next push.
    expect(await store.vehicles()).toEqual([]);
  });

  it('pushes a local tombstone up', async () => {
    const { store } = storeWith();
    const added = await store.addVehicle({ name: 'Civic' });
    await store.removeVehicle(added.id);
    const remote = new InMemoryRemoteStore();

    await syncOnce(store, remote, fakeClock());

    expect((await pulled(remote)).vehicles[0]?.deletedAt).not.toBeNull();
  });

  describe('hostile and degenerate input', () => {
    // Two gates, and which one catches a bad number is worth asserting rather
    // than blurring. Shape validation refuses anything **non-finite**; the
    // draft gate refuses anything **non-positive**. A test that accepted
    // either would still pass if one of them stopped working.
    it.each([
      ['NaN', Number.NaN],
      ['+Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
    ])('refuses %s gallons as the wrong shape', async (_label, gallons) => {
      const { store, repos: r } = storeWith();
      await r.vehicles.put(vehicle());
      const remote = new InMemoryRemoteStore(snapshot({ fillUps: [fillUp({ gallons })] }));

      const result = await syncOnce(store, remote, fakeClock());

      // +Infinity passes a `> 0` check, which is why finiteness is tested
      // explicitly and not left to the positivity check downstream.
      expect(result.ok && result.outcome.invalid).toHaveLength(1);
      expect(await store.fillUps('v1')).toEqual([]);
    });

    it.each([
      ['negative', -5],
      ['zero', 0],
    ])('refuses %s gallons at the draft gate', async (_label, gallons) => {
      const { store, repos: r } = storeWith();
      await r.vehicles.put(vehicle());
      const remote = new InMemoryRemoteStore(snapshot({ fillUps: [fillUp({ gallons })] }));

      const result = await syncOnce(store, remote, fakeClock());

      // Finite, so shape validation passes it on; it is the draft gate that
      // knows a fill-up cannot have zero gallons.
      expect(result.ok && result.outcome.invalid).toEqual([]);
      expect(result.ok && result.outcome.pulled.rejected).toHaveLength(1);
      expect(await store.fillUps('v1')).toEqual([]);
    });

    it('refuses a document whose fields are the wrong types entirely', async () => {
      const { store, repos: r } = storeWith();
      await r.vehicles.put(vehicle());
      const remote = new InMemoryRemoteStore();
      // Written straight past the typed push, the way a console edit or an
      // older build would leave it.
      await remote.push({
        ...emptySnapshot(),
        fillUps: [{ ...fillUp(), date: 'yesterday' } as never],
      });

      const result = await syncOnce(store, remote, fakeClock());

      expect(result.ok && result.outcome.invalid).toHaveLength(1);
      expect(await store.fillUps('v1')).toEqual([]);
    });

    it('keeps one bad row from costing the good ones', async () => {
      const { store, repos: r } = storeWith();
      await r.vehicles.put(vehicle());
      const remote = new InMemoryRemoteStore(
        snapshot({
          fillUps: [
            fillUp({ id: 'good-1', odometer: 10_000 }),
            fillUp({ id: 'bad', gallons: -1 }),
            fillUp({ id: 'good-2', odometer: 10_300 }),
          ],
        }),
      );

      const result = await syncOnce(store, remote, fakeClock());

      expect(result.ok && result.outcome.pulled.rejected).toHaveLength(1);
      expect(await store.fillUps('v1')).toHaveLength(2);
    });

    it('accepts a remote row dated in the future rather than discarding it', async () => {
      const clock = fakeClock();
      const { store, repos: r } = storeWith(clock);
      await r.vehicles.put(vehicle({ name: 'Local', updatedAt: 1_000 }));
      const ahead = clock.now() + 60 * 60 * 1000;
      const remote = new InMemoryRemoteStore(
        snapshot({ vehicles: [vehicle({ name: 'Ahead', updatedAt: ahead })] }),
      );

      await syncOnce(store, remote, clock);

      // Arriving first, it wins — which is correct, and is all this test used
      // to assert. What it also used to say was that a device with a wrong
      // clock winning "is the documented cost of the rule rather than a bug".
      // That was wrong: see the next test for what it costs.
      const [stored] = await store.vehicles();
      expect(stored?.name).toBe('Ahead');
    });

    it('does not let a device with a fast clock eat this device’s later edit', async () => {
      // The bug, in four steps:
      //   1. a device whose clock is an hour fast writes a row,
      //   2. it syncs to the account,
      //   3. this device edits the same row afterwards,
      //   4. this device pulls — and its own edit is overwritten, because the
      //      skewed row still compares as newer. rowsToPush then declines to
      //      push the edit, since local is no longer greater than remote.
      // The edit did not conflict, did not warn, and did not come back.
      const clock = fakeClock();
      const { store, repos: r } = storeWith(clock);
      const skewed = clock.now() + 60 * 60 * 1000;
      const remote = new InMemoryRemoteStore(
        snapshot({ vehicles: [vehicle({ id: 'v1', name: 'From the fast phone', updatedAt: skewed })] }),
      );

      await syncOnce(store, remote, clock);

      // Step 3: the correction, made on this device, after seeing that row.
      const seen = await store.vehicles();
      expect(seen[0]?.name).toBe('From the fast phone');
      await r.vehicles.put({ ...seen[0]!, name: 'Corrected here', updatedAt: clock.now() });

      await syncOnce(store, remote, clock);

      // It survives locally...
      expect((await store.vehicles())[0]?.name).toBe('Corrected here');
      // ...and reaches the account, which is the half that used to fail
      // silently.
      expect((await pulled(remote)).vehicles[0]?.name).toBe('Corrected here');
    });

    it('reports a row too far ahead to outbid instead of losing to it silently', async () => {
      const clock = fakeClock();
      const { store } = storeWith(clock);
      const absurd = clock.now() + 10 * 365 * 24 * 60 * 60 * 1000;
      const remote = new InMemoryRemoteStore(
        snapshot({ vehicles: [vehicle({ name: 'Decade ahead', updatedAt: absurd })] }),
      );

      const result = await syncOnce(store, remote, clock);

      // Adopting a decade of skew would push the clock toward the edge of
      // integer precision, so it is refused — and that means this row keeps
      // winning. Saying so is the only honest option left.
      expect(result.ok && result.outcome.unbeatable).toBe(1);
      expect((await store.vehicles())[0]?.name).toBe('Decade ahead');
    });

    it('still deletes a row that a fast clock wrote', async () => {
      // Tombstones used to be stamped with Date.now() inside the repository,
      // bypassing the injected clock — so a delete went on losing even after
      // edits stopped losing.
      const clock = fakeClock();
      const { store } = storeWith(clock);
      const skewed = clock.now() + 60 * 60 * 1000;
      const remote = new InMemoryRemoteStore(
        snapshot({ vehicles: [vehicle({ id: 'v1', updatedAt: skewed })] }),
      );

      await syncOnce(store, remote, clock);
      expect(await store.vehicles()).toHaveLength(1);

      await store.removeVehicle('v1');
      await syncOnce(store, remote, clock);

      expect(await store.vehicles()).toEqual([]);
      expect((await remote.pull()).vehicles).toHaveLength(1);
      expect((await pulled(remote)).vehicles[0]?.deletedAt).not.toBeNull();
      // And it stays deleted on the next sync rather than being resurrected.
      await syncOnce(store, remote, clock);
      expect(await store.vehicles()).toEqual([]);
    });

    it('leaves local storage untouched when the pull fails', async () => {
      const { store } = storeWith();
      await store.addVehicle({ name: 'Civic' });
      const remote = new InMemoryRemoteStore();
      remote.failPull = true;

      const result = await syncOnce(store, remote, fakeClock());

      expect(result.ok).toBe(false);
      expect(await store.vehicles()).toHaveLength(1);
    });

    it('keeps the pulled merge when only the push fails', async () => {
      const { store } = storeWith();
      const remote = new InMemoryRemoteStore(snapshot({ vehicles: [vehicle()] }));
      remote.failPush = true;

      const result = await syncOnce(store, remote, fakeClock());

      // The data arrived; only the upload did not. Throwing the merge away
      // would make an offline write worse than no sync at all.
      expect(result.ok).toBe(false);
      expect(await store.vehicles()).toHaveLength(1);
    });

    it('reports a receipt too large to sync instead of failing the row', async () => {
      const { store } = storeWith();
      const added = await store.addVehicle({ name: 'Civic' });
      const { makeFuelEntryDraft } = await import('../domain/fuelEntryDraft');
      const draft = makeFuelEntryDraft({
        date: new Date(1_700_000_000_000),
        odometer: 10_000,
        gallons: 10,
        pricePerGallon: 3.5,
        receiptImageData: new Uint8Array(900 * 1024),
      });
      expect(draft).not.toBeNull();
      await store.addFillUp(draft!, added.id);

      const remote = new InMemoryRemoteStore();
      remote.receiptByteLimit = 700 * 1024;

      const result = await syncOnce(store, remote, fakeClock());

      expect(result.ok && result.outcome.pushed.receiptsOmitted).toBe(1);
      // The fill-up itself still synced — only the photo stayed behind.
      expect((await pulled(remote)).fillUps).toHaveLength(1);
      expect((await pulled(remote)).fillUps[0]?.receiptImageData).toBeNull();
    });

    it('does not let a photoless round trip destroy the local photo', async () => {
      const { store } = storeWith();
      const added = await store.addVehicle({ name: 'Civic' });
      const { makeFuelEntryDraft } = await import('../domain/fuelEntryDraft');
      const draft = makeFuelEntryDraft({
        date: new Date(1_700_000_000_000),
        odometer: 10_000,
        gallons: 10,
        pricePerGallon: 3.5,
        receiptImageData: new Uint8Array(900 * 1024),
      });
      const entry = await store.addFillUp(draft!, added.id);

      const remote = new InMemoryRemoteStore();
      remote.receiptByteLimit = 700 * 1024;
      await syncOnce(store, remote, fakeClock());

      // Another device edits the row, so the account's photoless copy becomes
      // the newer one. Without preserveLocalReceipts this is where the only
      // remaining copy of the image would be overwritten with null.
      const current = await pulled(remote);
      await remote.push({
        ...emptySnapshot(),
        fillUps: [{ ...current.fillUps[0]!, updatedAt: Date.now() + 10_000, station: 'Edited' }],
      });

      await syncOnce(store, remote, fakeClock());

      const [stored] = await store.fillUps(added.id);
      expect(stored?.station).toBe('Edited');
      expect(stored?.id).toBe(entry.id);
      expect(stored?.receiptImageData?.byteLength).toBe(900 * 1024);
    });

    it('leaves a row written by a newer schema alone in the account', async () => {
      const { store } = storeWith();
      const remote = new InMemoryRemoteStore(
        snapshot({ vehicles: [vehicle({ schemaVersion: 99 })] }),
      );

      const result = await syncOnce(store, remote, fakeClock());

      expect(result.ok && result.outcome.skippedNewerSchema).toBe(1);
      expect(await store.vehicles()).toEqual([]);
      // Still there for the newer build that wrote it.
      expect((await pulled(remote)).vehicles).toHaveLength(1);
    });

    it('survives an account with nothing in it', async () => {
      const { store } = storeWith();
      const result = await syncOnce(store, new InMemoryRemoteStore(), fakeClock());
      expect(result.ok).toBe(true);
    });
  });
});

describe('one over-long field does not stop the upload (#50)', () => {
  /**
   * Refuses the whole batch the way Firestore does when any document breaks
   * `firestore.rules`: a coded `permission-denied`, all or nothing.
   *
   * The limits are written out as literals rather than imported from
   * `TEXT_LIMITS` on purpose — this stands in for the server, and a fake server
   * that reads the client's own numbers would agree with the client however
   * wrong it was. `rulesLimits.test.ts` ties those numbers to the real rules.
   */
  class RulesLikeRemote extends InMemoryRemoteStore {
    override async push(snapshot: Snapshot): Promise<import('./remote').PushSummary> {
      const tooLong = (value: string, max: number): boolean => value.length > max;
      const bad =
        snapshot.vehicles.some((row) => tooLong(row.name, 200) || tooLong(row.make, 200) || tooLong(row.model, 200)) ||
        snapshot.fillUps.some(
          (row) => tooLong(row.station, 200) || tooLong(row.notes, 4000) || tooLong(row.vehicleId, 200),
        );
      if (bad) {
        const error = new Error('Missing or insufficient permissions.');
        (error as unknown as Record<string, unknown>)['code'] = 'permission-denied';
        throw error;
      }
      return super.push(snapshot);
    }
  }

  /** A store holding rows written before text was bounded. */
  function legacyStore(rows: readonly FillUpRecord[]) {
    const clock = fakeClock();
    const repos = {
      vehicles: new InMemoryRepository<VehicleRecord>([vehicle()]),
      fillUps: new InMemoryRepository<FillUpRecord>(rows),
      pendingFillUps: new InMemoryRepository<import('./records').PendingFillUpRecord>(),
    };
    return { store: new FuelTrackerStore(repos, clock), repos, clock };
  }

  it('repairs a row an older build stored too long, and uploads everything', async () => {
    const { store, clock } = legacyStore([
      fillUp({ id: 'good', updatedAt: 900 }),
      fillUp({ id: 'long', updatedAt: 900, station: 's'.repeat(201) }),
    ]);
    const remote = new RulesLikeRemote();

    const result = await syncOnce(store, remote, clock);

    if (!result.ok) throw new Error(`expected success, got ${result.kind}: ${result.reason}`);
    expect(result.outcome.repaired).toBe(1);
    const uploaded = (await remote.pull()).fillUps as FillUpRecord[];
    expect(uploaded.map((row) => row.id).sort()).toEqual(['good', 'long']);
    expect(uploaded.find((row) => row.id === 'long')?.station).toHaveLength(200);
  });

  it('repairs once, not on every sync', async () => {
    const { store, clock } = legacyStore([fillUp({ id: 'long', updatedAt: 900, notes: 'n'.repeat(5000) })]);
    const remote = new RulesLikeRemote();
    await syncOnce(store, remote, clock);

    const second = await syncOnce(store, remote, clock);

    if (!second.ok) throw new Error(second.reason);
    expect(second.outcome.repaired).toBe(0);
  });

  it('holds back a row whose vehicle id cannot be stored, and uploads the rest', async () => {
    // Not repairable — shortening an id would point the fill-up at a vehicle
    // that does not exist. So it stays on the device and is reported, the way
    // an unstorable row id already is.
    const badVehicle = 'v'.repeat(300);
    const { store, clock } = legacyStore([
      fillUp({ id: 'good', updatedAt: 900 }),
      fillUp({ id: 'orphan', updatedAt: 900, vehicleId: badVehicle }),
    ]);
    const remote = new RulesLikeRemote();

    const result = await syncOnce(store, remote, clock);

    if (!result.ok) throw new Error(`expected success, got ${result.kind}: ${result.reason}`);
    expect(result.outcome.unsendable).toEqual(['orphan']);
    const uploaded = (await remote.pull()).fillUps as FillUpRecord[];
    expect(uploaded.map((row) => row.id)).toEqual(['good']);
  });

  it('bounds text arriving from the account, too', async () => {
    // A console edit or another build can put a long field in the account.
    const { store, clock } = legacyStore([]);
    const remote = new InMemoryRemoteStore(
      snapshot({ fillUps: [fillUp({ id: 'remote', updatedAt: 900, notes: 'n'.repeat(4001) })] }),
    );

    await syncOnce(store, remote, clock);

    const local = await store.exportSnapshot();
    expect(local.fillUps.find((row) => row.id === 'remote')?.notes).toHaveLength(4000);
  });
});

describe('the last check before a push (#50)', () => {
  it('holds back a row whose text is still too long, by id', () => {
    // Every door bounds text and sync repairs stored rows first, so in the app
    // this never fires. It is the backstop: if something new slips past, it
    // costs that row, not the whole batch.
    const unsendable: string[] = [];
    const sent = sendableRows(
      [fillUp({ id: 'fine' }), fillUp({ id: 'long', notes: 'n'.repeat(4001) })],
      unsendable,
    );
    expect(sent.map((row) => row.id)).toEqual(['fine']);
    expect(unsendable).toEqual(['long']);
  });

  it('lets text exactly at the limit through', () => {
    const unsendable: string[] = [];
    const sent = sendableRows([fillUp({ id: 'edge', station: 's'.repeat(200) })], unsendable);
    expect(sent).toHaveLength(1);
    expect(unsendable).toEqual([]);
  });
});

describe('incremental pull (#52)', () => {
  /**
   * Every sync used to read the entire account — every document, every receipt
   * photo — on every window focus. Now each upload is stamped by the server
   * (`syncedAt`), and a sync asks only for what changed since the newest stamp
   * it has seen, per collection. `InMemoryRemoteStore` simulates the stamps:
   * a seeded row has none (it predates the change), a pushed row gets one.
   */
  it('the first sync reads everything, including rows written before stamps existed', async () => {
    const remote = new InMemoryRemoteStore(snapshot({ vehicles: [vehicle()], fillUps: [fillUp()] }));
    const { store, clock } = storeWith();
    const state = new InMemorySyncState();

    const result = await syncOnce(store, remote, clock, state);

    if (!result.ok) throw new Error(result.reason);
    expect(remote.pullLog[0]?.since).toBeNull();
    expect((await store.exportSnapshot()).fillUps.map((row) => row.id)).toEqual(['f1']);
  });

  it('a steady-state sync downloads nothing at all', async () => {
    // The acceptance criterion: with nothing changed anywhere, no rows — and so
    // no receipt bytes — cross the wire. The second sync sees only this
    // device's own uploads echoed back once; the third sees nothing.
    const remote = new InMemoryRemoteStore(snapshot({ vehicles: [vehicle()], fillUps: [fillUp()] }));
    const { store, clock } = storeWith();
    const state = new InMemorySyncState();
    await store.addVehicle({ name: 'Second car' });

    await syncOnce(store, remote, clock, state);
    await syncOnce(store, remote, clock, state);
    await syncOnce(store, remote, clock, state);

    expect(remote.pullLog[2]?.rows).toBe(0);
    expect(remote.pullLog[2]?.since).not.toBeNull();
  });

  it('a steady-state sync uploads nothing either', async () => {
    // Re-sending an unchanged row would restamp it, and every other device
    // would download it again — the cost this whole change exists to remove.
    const remote = new InMemoryRemoteStore();
    const { store, clock } = storeWith();
    const state = new InMemorySyncState();
    await store.addVehicle({ name: 'Car' });
    await syncOnce(store, remote, clock, state);
    await syncOnce(store, remote, clock, state);

    const third = await syncOnce(store, remote, clock, state);

    if (!third.ok) throw new Error(third.reason);
    expect(third.outcome.pushed.written).toBe(0);
  });

  it('asks each collection for its own changes, with its own cursor', async () => {
    // Three collections are three reads at three moments. One shared cursor
    // could skip a write landing in one collection between two of the reads.
    const remote = new InMemoryRemoteStore(snapshot({ vehicles: [vehicle()] }));
    const { store, clock } = storeWith();
    const state = new InMemorySyncState();

    await syncOnce(store, remote, clock, state);
    await syncOnce(store, remote, clock, state);

    const since = remote.pullLog[1]?.since;
    expect(since).not.toBeNull();
    expect(Object.keys(since ?? {}).sort()).toEqual(['fillUps', 'pendingFillUps', 'vehicles']);
  });

  it('keeps each collection at its own mark, not the newest of all three', async () => {
    const remote = new InMemoryRemoteStore();
    const { store, clock } = storeWith();
    const state = new InMemorySyncState();
    const car = await store.addVehicle({ name: 'Car' });
    await syncOnce(store, remote, clock, state); // vehicle stamped first
    await store.addFillUp(
      makeFuelEntryDraft({ date: new Date(2026, 0, 1), odometer: 1000, gallons: 10, pricePerGallon: 3 })!,
      car.id,
    );
    await syncOnce(store, remote, clock, state); // fill-up stamped later
    await syncOnce(store, remote, clock, state); // both echoes read

    const marks = (await state.load())?.highWater;
    expect(marks?.vehicles).not.toBeNull();
    expect(marks?.fillUps).not.toBeNull();
    expect(marks?.vehicles).toBeLessThan(marks!.fillUps!);
  });

  it('never moves a collection\'s mark backwards', async () => {
    // An incremental read only returns newer stamps, so this cannot happen
    // with a correct remote — and if a remote ever got it wrong, a mark moving
    // back would just re-read; a mark moving forward wrongly would lose rows.
    const inner = new InMemoryRemoteStore();
    let lie = false;
    const remote: RemoteStore = {
      pull: async (since) => {
        const result = await inner.pull(since);
        return lie ? { ...result, highWater: { vehicles: 0, fillUps: 0, pendingFillUps: 0 } } : result;
      },
      push: (snapshot) => inner.push(snapshot),
    };
    const { store, clock } = storeWith();
    const state = new InMemorySyncState();
    await store.addVehicle({ name: 'Car' });
    await syncOnce(store, remote, clock, state);
    await syncOnce(store, remote, clock, state);
    const before = (await state.load())?.highWater.vehicles;

    lie = true;
    await syncOnce(store, remote, clock, state);

    expect((await state.load())?.highWater.vehicles).toBe(before);
  });

  it('with a remote that does not stamp, every read is full and rebuilds what is known', async () => {
    // A row that disappears from such a remote is sent again, exactly as when
    // every sync compared against the whole account.
    const inner = new InMemoryRemoteStore();
    const unstamped: RemoteStore = {
      pull: async () => {
        const { vehicles, fillUps, pendingFillUps } = await inner.pull();
        return { vehicles, fillUps, pendingFillUps };
      },
      push: (snapshot) => inner.push(snapshot),
    };
    const { store, clock } = storeWith();
    const state = new InMemorySyncState();
    const car = await store.addVehicle({ name: 'Car' });
    await syncOnce(store, unstamped, clock, state);
    await syncOnce(store, unstamped, clock, state);
    inner.forget('vehicles', car.id);

    await syncOnce(store, unstamped, clock, state);

    expect((await inner.pull()).vehicles).toHaveLength(1);
  });

  it('picks up exactly what another device changed since', async () => {
    const remote = new InMemoryRemoteStore();
    const a = storeWith(fakeClock(1_000_000));
    const aState = new InMemorySyncState();
    const b = storeWith(fakeClock(2_000_000));
    const bState = new InMemorySyncState();
    await syncOnce(a.store, remote, a.clock, aState);
    await syncOnce(a.store, remote, a.clock, aState);

    await b.store.addVehicle({ name: 'From B' });
    await syncOnce(b.store, remote, b.clock, bState);
    await syncOnce(a.store, remote, a.clock, aState);

    const last = remote.pullLog[remote.pullLog.length - 1];
    expect(last?.rows).toBe(1);
    expect((await a.store.vehicles()).map((v) => v.name)).toEqual(['From B']);
  });

  it('uploads a local change even when nothing remote changed', async () => {
    const remote = new InMemoryRemoteStore();
    const { store, clock } = storeWith();
    const state = new InMemorySyncState();
    await syncOnce(store, remote, clock, state);

    await store.addVehicle({ name: 'New' });
    const result = await syncOnce(store, remote, clock, state);

    if (!result.ok) throw new Error(result.reason);
    expect(result.outcome.pushed.written).toBe(1);
  });

  it('does not upload a row the account already has at the same version', async () => {
    // Without the full remote snapshot to compare against, "what to push" comes
    // from the versions this device knows the account holds. Pushing a row back
    // unchanged would restamp it and every other device would re-download it.
    const remote = new InMemoryRemoteStore(snapshot({ vehicles: [vehicle()] }));
    const { store, clock } = storeWith();
    const state = new InMemorySyncState();
    await syncOnce(store, remote, clock, state);

    const second = await syncOnce(store, remote, clock, state);

    if (!second.ok) throw new Error(second.reason);
    expect(second.outcome.pushed.written).toBe(0);
  });

  it('rebuilds the clock floor from what it knows, not only from what it pulled', async () => {
    // Every full pull used to re-observe every remote row, which is what keeps
    // a slow device's edits newer than a fast device's. An incremental pull
    // sees only changes, so after a reload — a fresh clock — the floor would be
    // gone and this device's next edit would silently lose to the old row.
    const ahead = 1_000_000 + 86_400_000; // a day ahead: inside the adoption bound
    const remote = new InMemoryRemoteStore(snapshot({ vehicles: [vehicle({ updatedAt: ahead })] }));
    const state = new InMemorySyncState();
    const first = storeWith(fakeClock(1_000_000));
    await syncOnce(first.store, remote, first.clock, state);

    // A new session a little later: the clock's floor is gone. Still behind
    // the fast device, which is the whole point.
    const reloadedClock = fakeClock(1_000_000 + 60_000);
    await syncOnce(first.store, remote, reloadedClock, state);

    // It must have been an incremental read — a full one would rebuild the
    // floor from the pulled rows and prove nothing. (It once silently was:
    // the last full read was timed by the merge clock, which had jumped ahead,
    // so the reloaded device thought it was in the future and read in full.)
    expect(remote.pullLog[1]?.since).not.toBeNull();
    expect(reloadedClock.now()).toBeGreaterThan(ahead);
  });

  it('starts over with a full read when the saved cursor is from another version', async () => {
    const remote = new InMemoryRemoteStore(snapshot({ vehicles: [vehicle()] }));
    const { store, clock } = storeWith();
    const state = new InMemorySyncState();
    await syncOnce(store, remote, clock, state);
    const saved = await state.load();
    await state.save({ ...saved!, version: saved!.version + 1 });

    await syncOnce(store, remote, clock, state);

    expect(remote.pullLog[1]?.since).toBeNull();
  });

  it('reconciles with a full read once the last one is a week old', async () => {
    // The safety net for anything an incremental read cannot see — a document
    // deleted outright in the console, say. A full read rebuilds what the
    // device believes the account holds, so a row missing there is re-sent.
    const remote = new InMemoryRemoteStore();
    const { store, clock } = storeWith();
    const state = new InMemorySyncState();
    await store.addVehicle({ name: 'Kept' });
    await syncOnce(store, remote, clock, state);
    const saved = await state.load();
    await state.save({ ...saved!, fullPulledAt: saved!.fullPulledAt - 8 * 86_400_000 });
    remote.forget('vehicles', (await store.vehicles())[0]!.id);

    await syncOnce(store, remote, clock, state);

    expect(remote.pullLog[1]?.since).toBeNull();
    expect((await remote.pull()).vehicles).toHaveLength(1);
  });

  it('does not move the cursor when the pull fails', async () => {
    const remote = new InMemoryRemoteStore(snapshot({ vehicles: [vehicle()] }));
    const { store, clock } = storeWith();
    const state = new InMemorySyncState();
    await syncOnce(store, remote, clock, state);
    const before = await state.load();
    remote.failPull = true;

    await syncOnce(store, remote, clock, state);

    expect(await state.load()).toEqual(before);
  });

  it('keeps a change that failed to upload, and sends it next time', async () => {
    const remote = new InMemoryRemoteStore();
    const { store, clock } = storeWith();
    const state = new InMemorySyncState();
    await syncOnce(store, remote, clock, state);
    await store.addVehicle({ name: 'Pending' });
    remote.failPush = true;
    await syncOnce(store, remote, clock, state);

    remote.failPush = false;
    const retry = await syncOnce(store, remote, clock, state);

    if (!retry.ok) throw new Error(retry.reason);
    expect(retry.outcome.pushed.written).toBe(1);
    expect((await remote.pull()).vehicles).toHaveLength(1);
  });
});
