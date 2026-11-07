import { describe, expect, test } from 'vitest';
import { makeFuelEntryDraft, type FuelEntryDraft } from '../domain/fuelEntryDraft';
import { InMemoryRepository } from './repository';
import type { FillUpRecord, PendingFillUpRecord, SyncFields, VehicleRecord } from './records';
import { FuelTrackerStore } from './store';
import { InMemorySharingWorld, type Account } from './sharing';
import { syncAll, type SharingSync } from './shareSync';
import { syncOnce } from './sync';
import { InMemoryShareLedger, InMemorySyncState } from './syncState';
import { MonotonicClock } from './syncClock';
import { LocalView } from './localView';

/**
 * Sync reads this device once, not once per step (#87).
 *
 * #52 made the network side incremental; the local side still read whole
 * tables — every receipt photo included — about seven times per remote: two
 * snapshots per `syncOnce`, the merge's own lookups, the text repair, and one
 * more snapshot per shared car just to find that car. On a phone with a few
 * hundred photographed fill-ups that was tens of megabytes per sync, on every
 * focus and every save. And single-row questions — "have I seen this
 * submission?", "is this my car?" — scanned every tombstone to answer.
 */
class CountingRepository<T extends SyncFields & { readonly vehicleId?: string }> extends InMemoryRepository<T> {
  /** Reads of every live row, or every row. */
  wholeTableReads = 0;
  /** Reads of every tombstone. */
  tombstoneReads = 0;

  override async list(): Promise<T[]> {
    this.wholeTableReads += 1;
    return super.list();
  }

  override async listDeleted(): Promise<T[]> {
    this.tombstoneReads += 1;
    return super.listDeleted();
  }

  override async listAll(): Promise<T[]> {
    this.wholeTableReads += 1;
    return super.listAll();
  }

  reset(): void {
    this.wholeTableReads = 0;
    this.tombstoneReads = 0;
  }

  /** Every read that touches more than the rows asked for. */
  get scans(): number {
    return this.wholeTableReads + this.tombstoneReads;
  }
}

interface Counted {
  readonly vehicles: CountingRepository<VehicleRecord>;
  readonly fillUps: CountingRepository<FillUpRecord>;
  readonly pendingFillUps: CountingRepository<PendingFillUpRecord>;
}

function countedStore(clock: MonotonicClock, author: string): { store: FuelTrackerStore; repos: Counted } {
  const repos: Counted = {
    vehicles: new CountingRepository<VehicleRecord>(),
    fillUps: new CountingRepository<FillUpRecord>(),
    pendingFillUps: new CountingRepository<PendingFillUpRecord>(),
  };
  return { store: new FuelTrackerStore(repos, clock, author), repos };
}

function reset(repos: Counted): void {
  repos.vehicles.reset();
  repos.fillUps.reset();
  repos.pendingFillUps.reset();
}

function draft(odometer: number): FuelEntryDraft {
  const made = makeFuelEntryDraft({ date: new Date(2026, 0, 1), odometer, gallons: 10, pricePerGallon: 3.5 });
  if (made === null) throw new Error('fixture draft failed validation');
  return made;
}

const ME: Account = { uid: 'me', name: 'Sam', email: 'sam@example.com', emailVerified: true };

function sharingFor(world: InMemorySharingWorld, account: Account): SharingSync {
  const states = new Map<string, InMemorySyncState>();
  return {
    remote: world.sharingFor(account),
    stateFor: (key) => {
      const state = states.get(key) ?? new InMemorySyncState();
      states.set(key, state);
      return state;
    },
    forgetState: async (key) => {
      states.delete(key);
    },
    ledger: new InMemoryShareLedger(),
  };
}

/** `shares` owners each share one car, with a fill-up, with ME. */
async function member(shares: number) {
  const world = new InMemorySharingWorld();
  const clock = new MonotonicClock();
  const { store, repos } = countedStore(clock, ME.uid);
  for (let i = 0; i < 3; i += 1) {
    const car = await store.addVehicle({ name: `Mine ${i}` });
    await store.addFillUp(draft(10_000 + i), car.id);
  }
  for (let i = 0; i < shares; i += 1) {
    const owner: Account = { uid: `owner-${i}`, name: `Owner ${i}`, email: `o${i}@example.com`, emailVerified: true };
    const ownerStore = new FuelTrackerStore(
      {
        vehicles: new InMemoryRepository<VehicleRecord>(),
        fillUps: new InMemoryRepository<FillUpRecord>(),
        pendingFillUps: new InMemoryRepository<PendingFillUpRecord>(),
      },
      new MonotonicClock(),
      owner.uid,
    );
    const car = await ownerStore.addVehicle({ name: `Theirs ${i}` });
    await ownerStore.addFillUp(draft(20_000 + i), car.id);
    await syncOnce(ownerStore, world.remoteFor(owner.uid), new MonotonicClock(), new InMemorySyncState());
    const invite = await world.sharingFor(owner).invite(car, ME.email);
    await world.sharingFor(ME).accept(invite);
  }
  const sharing = sharingFor(world, ME);
  const ownState = new InMemorySyncState();
  const sync = () => syncAll(store, world.remoteFor(ME.uid), sharing, clock, ownState);
  return { store, repos, sync, world };
}

describe('one sync reads each table at most once (#87)', () => {
  test.each([0, 1, 3])('with %i shared car(s), a sync with nothing new', async (shares) => {
    const { repos, sync } = await member(shares);
    await sync();
    reset(repos);

    const result = await sync();

    expect(result.own.ok).toBe(true);
    expect(result.shares.synced).toHaveLength(shares);
    // One snapshot of the device, shared by every remote — not one per step.
    expect(repos.fillUps.scans).toBeLessThanOrEqual(1);
    expect(repos.vehicles.scans).toBeLessThanOrEqual(1);
    expect(repos.pendingFillUps.scans).toBeLessThanOrEqual(1);
  });

  test.each([0, 1, 3])('with %i shared car(s), a sync that sends and receives', async (shares) => {
    const { store, repos, sync } = await member(shares);
    await sync();
    const [car] = await store.vehicles();
    if (car === undefined) throw new Error('no car');
    await store.addFillUp(draft(30_000), car.id);
    reset(repos);

    expect((await sync()).own.ok).toBe(true);

    expect(repos.fillUps.scans).toBeLessThanOrEqual(1);
  });

  test('a single syncOnce reads each table once', async () => {
    const world = new InMemorySharingWorld();
    const clock = new MonotonicClock();
    const { store, repos } = countedStore(clock, 'solo');
    const car = await store.addVehicle({ name: 'Solo' });
    await store.addFillUp(draft(10_000), car.id);
    reset(repos);

    expect((await syncOnce(store, world.remoteFor('solo'), clock, new InMemorySyncState())).ok).toBe(true);

    expect(repos.fillUps.scans).toBeLessThanOrEqual(1);
    expect(repos.vehicles.scans).toBeLessThanOrEqual(1);
  });
});

describe('single-row questions read single rows (#87)', () => {
  async function seeded() {
    const clock = new MonotonicClock();
    const { store, repos } = countedStore(clock, 'owner');
    const car = await store.addVehicle({ name: 'Civic' });
    const gone = await store.addVehicle({ name: 'Gone' });
    await store.removeVehicle(gone.id);
    const fillUp = await store.addFillUp(draft(10_000), car.id);
    const deleted = await store.addFillUp(draft(10_100), car.id);
    await store.removeFillUp(deleted.id);
    reset(repos);
    return { store, repos, car, gone, fillUp, deleted };
  }

  test('an export reads each table exactly once, tombstones included', async () => {
    const { store, repos } = await seeded();
    const snapshot = await store.exportSnapshot();
    expect(snapshot.vehicles).toHaveLength(2);
    expect(snapshot.fillUps).toHaveLength(2);
    expect([repos.vehicles.scans, repos.fillUps.scans, repos.pendingFillUps.scans]).toEqual([1, 1, 1]);
  });

  test('a merge looks up the rows it was given, not every row', async () => {
    const { store, repos, car } = await seeded();
    const [stored] = (await store.exportSnapshot()).fillUps;
    if (stored === undefined) throw new Error('no fill-up');
    reset(repos);
    await store.importBackup({
      vehicles: [{ ...car, name: 'Renamed', updatedAt: car.updatedAt + 10 }],
      fillUps: [{ ...stored, updatedAt: stored.updatedAt - 1 }],
      pendingFillUps: [],
    });
    expect([repos.vehicles.scans, repos.fillUps.scans, repos.pendingFillUps.scans]).toEqual([0, 0, 0]);
    expect((await store.vehicles()).map((v) => v.name)).toContain('Renamed');
  });

  test('whether a car is here — live or deleted — reads that car only', async () => {
    const { store, repos, car, gone } = await seeded();
    expect(await store.hasVehicle(car.id)).toBe(true);
    expect(await store.hasVehicle(gone.id)).toBe(true);
    expect(await store.hasVehicle('never')).toBe(false);
    expect(repos.vehicles.scans).toBe(0);
  });

  test('a duplicate submission is recognised by id, approved or not', async () => {
    const { store, repos, car } = await seeded();
    const submission = { id: 'sub-1', vehicleId: car.id, submitterName: 'Sam', submittedAt: 1, draft: draft(10_200) };
    await store.receiveSubmission(submission);
    await store.rejectPendingFillUp('sub-1');
    reset(repos);
    expect(await store.receiveSubmission(submission)).toBe('duplicate');
    expect(repos.pendingFillUps.scans).toBe(0);
  });

  test('re-stamping finds deleted rows by id, without a scan per row', async () => {
    const { store, repos, fillUp, deleted } = await seeded();
    await store.restamp('fillUps', [fillUp.id, deleted.id, 'never']);
    expect(repos.fillUps.scans).toBe(0);
    const all = (await store.exportSnapshot()).fillUps;
    expect(all.find((row) => row.id === deleted.id)?.updatedAt).toBeGreaterThan(deleted.updatedAt);
  });

  test('forgetting a shared car reads that car’s rows, tombstones included, and nothing else', async () => {
    const { store, repos, car, fillUp, deleted } = await seeded();
    await store.forgetVehicle(car.id);
    expect([repos.vehicles.scans, repos.fillUps.scans, repos.pendingFillUps.scans]).toEqual([0, 0, 0]);
    const all = await store.exportSnapshot();
    expect(all.fillUps.map((row) => row.id)).not.toContain(fillUp.id);
    expect(all.fillUps.map((row) => row.id)).not.toContain(deleted.id);
    expect(all.vehicles.map((row) => row.id)).not.toContain(car.id);
  });
});

describe('reading once does not change what is sent (#87)', () => {
  test('a fill-up saved while a sync is running is sent by the next sync', async () => {
    const world = new InMemorySharingWorld();
    const clock = new MonotonicClock();
    const { store } = countedStore(clock, 'solo');
    const car = await store.addVehicle({ name: 'Solo' });
    const remote = world.remoteFor('solo');
    const state = new InMemorySyncState();
    await syncOnce(store, remote, clock, state);

    // Saved after this sync has looked at the device, before it pushes.
    let saved: FillUpRecord | null = null;
    const pull = remote.pull.bind(remote);
    remote.pull = async (since) => {
      const raw = await pull(since);
      saved = await store.addFillUp(draft(10_500), car.id);
      return raw;
    };
    const local = new LocalView(store);
    await local.snapshot(); // the view is read before the save lands
    await syncOnce(store, remote, clock, state, { local });
    remote.pull = pull;
    await syncOnce(store, remote, clock, state);

    const ids = ((await remote.pull(null)).fillUps as FillUpRecord[]).map((row) => row.id);
    expect(saved).not.toBeNull();
    expect(ids).toContain(saved!.id);
  });

  test('text repaired once, in the account’s own sync, still reaches a shared car’s owner', async () => {
    const { store, repos, sync, world } = await member(1);
    await sync();
    const car = (await store.vehicles()).find((v) => v.name.startsWith('Theirs'));
    if (car === undefined) throw new Error('no shared car');
    // A fill-up an older build stored before text was bounded (#50).
    const mine = await store.addFillUp(draft(20_500), car.id);
    const stored = await store.fillUp(mine.id);
    if (stored === undefined) throw new Error('no fill-up');
    await repos.fillUps.put({ ...stored, notes: 'x'.repeat(10_000), updatedAt: stored.updatedAt + 1 });

    const result = await sync();

    expect(result.own.ok && result.own.outcome.repaired).toBe(1);
    expect(result.shares.synced).toHaveLength(1);
    expect(result.shares.failed).toEqual([]);
    expect(((await store.fillUp(mine.id))?.notes.length ?? 0)).toBeLessThan(10_000);
    // And the owner's account has the shortened row, not the old one.
    const theirs = ((await world.remoteFor('owner-0').pull(null)).fillUps as FillUpRecord[]).find((row) => row.id === mine.id);
    expect(theirs).toBeDefined();
    expect(theirs?.notes.length ?? Infinity).toBeLessThan(10_000);
  });
});
