import { describe, expect, it } from 'vitest';
import { InMemoryRepository } from './repository';
import { InMemoryRemoteStore, emptySnapshot, rowsToPush } from './remote';
import { FuelTrackerStore } from './store';
import { MonotonicClock } from './syncClock';
import { SCHEMA_VERSION, type FillUpRecord, type VehicleRecord } from './records';
import { validateSnapshot } from './recordValidation';
import { partitionBySchema, preserveLocalReceipts, syncOnce } from './sync';
import type { BackupSnapshot } from '../domain/backupFormat';

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

function snapshot(overrides: Partial<BackupSnapshot> = {}): BackupSnapshot {
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
async function pulled(remote: InMemoryRemoteStore): Promise<BackupSnapshot> {
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
