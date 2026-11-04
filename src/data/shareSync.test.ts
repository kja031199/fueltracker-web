import { describe, expect, test } from 'vitest';
import { InMemoryRepository } from './repository';
import type { FillUpRecord, PendingFillUpRecord, VehicleRecord } from './records';
import { FuelTrackerStore } from './store';
import { InMemorySharingWorld, Refused, type Account } from './sharing';
import { excluding, onlyFillUpsOf, shareStateKey, syncAll, type SharingSync } from './shareSync';
import { InMemoryShareLedger, InMemorySyncState, type SyncStateStore } from './syncState';
import { MonotonicClock } from './syncClock';
import { makeFuelEntryDraft, type FuelEntryDraft } from '../domain/fuelEntryDraft';
import { computeFuelStatistics } from '../domain/fuelStatistics';
import { toStats } from './records';

/**
 * Two people, one car (#66), end to end through sync — against an in-memory
 * world that enforces the same rules as `firestore.rules`.
 */

const OWNER: Account = { uid: 'owner', name: 'Kyle', email: 'kyle@example.com', emailVerified: true };
const PARTNER: Account = { uid: 'partner', name: 'Sam', email: 'Sam@Example.com', emailVerified: true };

interface Device {
  readonly account: Account;
  readonly store: FuelTrackerStore;
  readonly sharing: SharingSync;
  readonly ownState: SyncStateStore;
  sync(): ReturnType<typeof syncAll>;
}

function device(world: InMemorySharingWorld, account: Account): Device {
  // One clock for the store and its sync, as the app has (`sharedSyncClock`).
  const clock = new MonotonicClock();
  const store = new FuelTrackerStore(
    {
      vehicles: new InMemoryRepository<VehicleRecord>(),
      fillUps: new InMemoryRepository<FillUpRecord>(),
      pendingFillUps: new InMemoryRepository<PendingFillUpRecord>(),
    },
    clock,
    account.uid,
  );
  const states = new Map<string, InMemorySyncState>();
  const sharing: SharingSync = {
    remote: world.sharingFor(account),
    stateFor: (key) => {
      let state = states.get(key);
      if (state === undefined) {
        state = new InMemorySyncState();
        states.set(key, state);
      }
      return state;
    },
    forgetState: async (key) => {
      states.delete(key);
    },
    ledger: new InMemoryShareLedger(),
  };
  const ownState = new InMemorySyncState();
  return {
    account,
    store,
    sharing,
    ownState,
    sync: () => syncAll(store, world.remoteFor(account.uid), sharing, clock, ownState),
  };
}

function draft(odometer: number, gallons = 10): FuelEntryDraft {
  const made = makeFuelEntryDraft({ date: new Date(2026, 0, odometer / 100), odometer, gallons, pricePerGallon: 3.5 });
  if (made === null) throw new Error('fixture draft failed validation');
  return made;
}

/** The owner with a car, a fill-up on it, synced; the partner invited and joined. */
async function sharedCar(): Promise<{
  world: InMemorySharingWorld;
  owner: Device;
  partner: Device;
  car: VehicleRecord;
}> {
  const world = new InMemorySharingWorld();
  const owner = device(world, OWNER);
  const partner = device(world, PARTNER);
  const car = await owner.store.addVehicle({ name: 'Civic' });
  await owner.store.addFillUp(draft(10_000), car.id);
  await owner.sync();
  const invite = await owner.sharing.remote.invite(car, 'sam@example.com');
  await partner.sharing.remote.accept(invite);
  return { world, owner, partner, car };
}

async function rowsIn(world: InMemorySharingWorld, uid: string): Promise<{ vehicles: string[]; fillUps: string[] }> {
  const raw = await world.remoteFor(uid).pull(null);
  return {
    vehicles: (raw.vehicles as VehicleRecord[]).map((v) => v.id),
    fillUps: (raw.fillUps as FillUpRecord[]).map((f) => f.id),
  };
}

describe('joining', () => {
  test('the partner’s next sync brings the car and its history', async () => {
    const { partner, car } = await sharedCar();
    const result = await partner.sync();
    expect(result.own.ok).toBe(true);
    expect(result.shares.synced.map((m) => m.vehicleId)).toEqual([car.id]);
    expect((await partner.store.vehicles()).map((v) => v.name)).toEqual(['Civic']);
    expect(await partner.store.fillUps(car.id)).toHaveLength(1);
  });

  test('the shared car is never copied into the partner’s own account', async () => {
    const { world, partner } = await sharedCar();
    await partner.sync();
    await partner.sync();
    expect(await rowsIn(world, PARTNER.uid)).toEqual({ vehicles: [], fillUps: [] });
  });

  test('an invitation alone shares nothing', async () => {
    const world = new InMemorySharingWorld();
    const owner = device(world, OWNER);
    const partner = device(world, PARTNER);
    const car = await owner.store.addVehicle({ name: 'Civic' });
    await owner.sync();
    await owner.sharing.remote.invite(car, 'sam@example.com');
    await partner.sync();
    expect(await partner.store.vehicles()).toHaveLength(0);
  });
});

describe('both logging the same car', () => {
  test('a fill-up the partner logs reaches the owner, entered by the partner', async () => {
    const { owner, partner, car } = await sharedCar();
    await partner.sync();
    const theirs = await partner.store.addFillUp(draft(10_300), car.id);
    await partner.sync();
    await owner.sync();
    const seen = (await owner.store.fillUps(car.id)).find((f) => f.id === theirs.id);
    expect(seen).toBeDefined();
    expect((await owner.store.fillUp(theirs.id))?.enteredBy).toBe(PARTNER.uid);
  });

  test('the owner’s edits and deletions reach the partner', async () => {
    const { owner, partner, car } = await sharedCar();
    await partner.sync();
    const [first] = await owner.store.fillUps(car.id);
    await owner.store.updateFillUp(first!.id, draft(10_050), car.id);
    const extra = await owner.store.addFillUp(draft(10_400), car.id);
    await owner.sync();
    await partner.sync();
    expect((await partner.store.fillUp(first!.id))?.odometer).toBe(10_050);
    await owner.store.removeFillUp(extra.id);
    await owner.sync();
    await partner.sync();
    expect((await partner.store.fillUps(car.id)).map((f) => f.id)).toEqual([first!.id]);
  });

  test('the partner can correct and delete a fill-up too', async () => {
    const { owner, partner, car } = await sharedCar();
    await partner.sync();
    const [first] = await partner.store.fillUps(car.id);
    await partner.store.updateFillUp(first!.id, draft(10_010), car.id);
    await partner.sync();
    await owner.sync();
    expect((await owner.store.fillUp(first!.id))?.odometer).toBe(10_010);
    // Still the owner's entry, whoever corrected it.
    expect((await owner.store.fillUp(first!.id))?.enteredBy).toBe(OWNER.uid);

    await partner.store.removeFillUp(first!.id);
    await partner.sync();
    await owner.sync();
    expect(await owner.store.fillUps(car.id)).toHaveLength(0);
  });

  test('both devices compute the same statistics for the car', async () => {
    const { owner, partner, car } = await sharedCar();
    await partner.sync();
    await partner.store.addFillUp(draft(10_310, 9), car.id);
    await partner.sync();
    await owner.store.addFillUp(draft(10_640, 11), car.id);
    await owner.sync();
    await partner.sync();
    await owner.sync();
    // The result carries two functions and a Set, which `toEqual` compares
    // by identity — so compare the data, and the functions by their answers.
    const stats = async (d: Device): Promise<Record<string, unknown>> => {
      const entries = await d.store.fillUps(car.id);
      const result = computeFuelStatistics(toStats(entries));
      const data: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(result)) {
        if (typeof value === 'function') continue;
        data[key] = value instanceof Set ? [...value].sort() : value;
      }
      data['mpg'] = entries.map((entry) => [entry.id, result.mpgFor(entry.id), result.isSuspectSegment(entry.id)]);
      return data;
    };
    expect(await stats(partner)).toEqual(await stats(owner));
  });
});

describe('everything else stays private', () => {
  test('the partner’s own car stays in the partner’s account, and the owner’s other car never arrives', async () => {
    const { world, owner, partner } = await sharedCar();
    const ownersOther = await owner.store.addVehicle({ name: 'Truck' });
    await owner.store.addFillUp(draft(50_000), ownersOther.id);
    await owner.sync();
    const partnersOwn = await partner.store.addVehicle({ name: 'Bike' });
    await partner.store.addFillUp(draft(1_000), partnersOwn.id);
    await partner.sync();

    expect((await partner.store.vehicles()).map((v) => v.name).sort()).toEqual(['Bike', 'Civic']);
    expect((await rowsIn(world, PARTNER.uid)).vehicles).toEqual([partnersOwn.id]);
    expect((await rowsIn(world, OWNER.uid)).vehicles).not.toContain(partnersOwn.id);
  });
});

describe('when sharing ends', () => {
  test('removed by the owner: the partner forgets the car, and pushes nothing about it', async () => {
    const { world, owner, partner, car } = await sharedCar();
    await partner.sync();
    const before = await rowsIn(world, OWNER.uid);
    await owner.sharing.remote.removeMember(car.id, PARTNER.uid);

    const result = await partner.sync();

    expect(result.shares.ended.map((m) => m.vehicleId)).toEqual([car.id]);
    expect(await partner.store.vehicles()).toHaveLength(0);
    expect((await partner.store.exportSnapshot()).fillUps).toHaveLength(0);
    // The owner's account is untouched — no tombstone from the partner.
    expect(await rowsIn(world, OWNER.uid)).toEqual(before);
    expect(await partner.sharing.remote.memberships()).toHaveLength(0);
  });

  test('left on another device: this device forgets it too', async () => {
    const { world, partner, car } = await sharedCar();
    await partner.sync();
    const otherDevice = device(world, PARTNER);
    const [membership] = await otherDevice.sharing.remote.memberships();
    await otherDevice.sharing.remote.leave(membership!);

    await partner.sync();

    expect(await partner.store.vehicles()).toHaveLength(0);
    expect(await partner.store.fillUps(car.id)).toHaveLength(0);
  });

  test('the owner deletes the car: it disappears for the partner, who is no longer a member', async () => {
    const { world, owner, partner, car } = await sharedCar();
    await partner.sync();
    await owner.store.removeVehicle(car.id);
    await owner.sync();

    const result = await partner.sync();

    expect(result.shares.ended.map((m) => m.vehicleId)).toEqual([car.id]);
    expect(await partner.store.vehicles()).toHaveLength(0);
    expect(world.isMember(OWNER.uid, car.id, PARTNER.uid)).toBe(false);
  });

  test('a fill-up the partner logged before leaving stays the owner’s', async () => {
    const { owner, partner, car } = await sharedCar();
    await partner.sync();
    const theirs = await partner.store.addFillUp(draft(10_300), car.id);
    await partner.sync();
    const [membership] = await partner.sharing.remote.memberships();
    await partner.sharing.remote.leave(membership!);
    await partner.sync();
    await owner.sync();
    expect((await owner.store.fillUp(theirs.id))?.enteredBy).toBe(PARTNER.uid);
  });
});

describe('when the sharing list cannot be read', () => {
  test('the account’s own sync still runs, and shared rows are neither lost nor copied', async () => {
    const { world, partner, car } = await sharedCar();
    await partner.sync();
    const remote = partner.sharing.remote;
    remote.memberships = async () => {
      throw new Error('offline');
    };
    const mine = await partner.store.addVehicle({ name: 'Bike' });

    const result = await partner.sync();

    expect(result.own.ok).toBe(true);
    expect(result.shares.unreachable).toBe(true);
    expect(await partner.store.fillUps(car.id)).toHaveLength(1);
    expect((await rowsIn(world, PARTNER.uid)).vehicles).toEqual([mine.id]);
  });
});

// --- Broader scenarios -------------------------------------------------------

const THIRD: Account = { uid: 'third', name: 'Alex', email: 'alex@example.com', emailVerified: true };

describe('the scopes, on their own', () => {
  test('excluding() keeps every row but the shared cars’', () => {
    const scope = excluding(new Set(['shared']));
    expect(scope('vehicles', { id: 'mine' })).toBe(true);
    expect(scope('vehicles', { id: 'shared' })).toBe(false);
    expect(scope('fillUps', { id: 'f', vehicleId: 'mine' })).toBe(true);
    expect(scope('fillUps', { id: 'f', vehicleId: 'shared' })).toBe(false);
    expect(scope('pendingFillUps', { id: 'p', vehicleId: 'shared' })).toBe(false);
    expect(scope('pendingFillUps', { id: 'p', vehicleId: 'mine' })).toBe(true);
  });

  test('excluding() nothing excludes nothing', () => {
    const scope = excluding(new Set());
    expect(scope('vehicles', { id: 'x' })).toBe(true);
    expect(scope('fillUps', { id: 'f' })).toBe(true);
  });

  test('onlyFillUpsOf() is that car’s fill-ups — never the car, never submissions', () => {
    const scope = onlyFillUpsOf('shared');
    expect(scope('fillUps', { id: 'f', vehicleId: 'shared' })).toBe(true);
    expect(scope('fillUps', { id: 'f', vehicleId: 'other' })).toBe(false);
    expect(scope('fillUps', { id: 'f' })).toBe(false);
    expect(scope('vehicles', { id: 'shared' })).toBe(false);
    expect(scope('pendingFillUps', { id: 'p', vehicleId: 'shared' })).toBe(false);
  });

  test('a share’s cursor key names the owner and the car', () => {
    expect(shareStateKey({ ownerUid: 'o', vehicleId: 'v' })).toBe('share:o__v');
    expect(shareStateKey({ ownerUid: 'o', vehicleId: 'v' })).not.toBe(shareStateKey({ ownerUid: 'v', vehicleId: 'o' }));
  });
});

describe('several shares at once', () => {
  test('cars from two different owners, and losing one keeps the other', async () => {
    const { world, partner, car } = await sharedCar();
    const third = device(world, THIRD);
    const van = await third.store.addVehicle({ name: 'Van' });
    await third.store.addFillUp(draft(30_000), van.id);
    await third.sync();
    await partner.sharing.remote.accept(await third.sharing.remote.invite(van, PARTNER.email));

    await partner.sync();
    expect((await partner.store.vehicles()).map((v) => v.name).sort()).toEqual(['Civic', 'Van']);

    await third.sharing.remote.removeMember(van.id, PARTNER.uid);
    const result = await partner.sync();
    expect(result.shares.ended.map((m) => m.vehicleId)).toEqual([van.id]);
    expect(result.shares.synced.map((m) => m.vehicleId)).toEqual([car.id]);
    expect((await partner.store.vehicles()).map((v) => v.name)).toEqual(['Civic']);
  });

  test('sharing in both directions: each sees the other’s car, neither is copied', async () => {
    const { world, owner, partner, car } = await sharedCar();
    const bike = await partner.store.addVehicle({ name: 'Bike' });
    await partner.sync();
    await owner.sharing.remote.accept(await partner.sharing.remote.invite(bike, OWNER.email));
    await owner.sync();
    await partner.sync();

    expect((await owner.store.vehicles()).map((v) => v.name).sort()).toEqual(['Bike', 'Civic']);
    expect((await partner.store.vehicles()).map((v) => v.name).sort()).toEqual(['Bike', 'Civic']);
    expect((await rowsIn(world, OWNER.uid)).vehicles).toEqual([car.id]);
    expect((await rowsIn(world, PARTNER.uid)).vehicles).toEqual([bike.id]);
  });

  test('one share that cannot be reached does not stop the others, and nothing is forgotten', async () => {
    const { world, partner, car } = await sharedCar();
    const third = device(world, THIRD);
    const van = await third.store.addVehicle({ name: 'Van' });
    await third.sync();
    await partner.sharing.remote.accept(await third.sharing.remote.invite(van, PARTNER.email));
    await partner.sync();

    const realScoped = partner.sharing.remote.scoped.bind(partner.sharing.remote);
    partner.sharing.remote.scoped = (membership) =>
      membership.vehicleId === van.id
        ? { pull: () => Promise.reject(new Error('offline')), push: () => Promise.reject(new Error('offline')) }
        : realScoped(membership);

    const result = await partner.sync();
    expect(result.shares.failed.map((m) => m.vehicleId)).toEqual([van.id]);
    expect(result.shares.synced.map((m) => m.vehicleId)).toEqual([car.id]);
    expect(result.shares.ended).toHaveLength(0);
    expect((await partner.store.vehicles()).map((v) => v.name).sort()).toEqual(['Civic', 'Van']);
    expect((await partner.sharing.ledger.load()).map((m) => m.vehicleId).sort()).toEqual([car.id, van.id].sort());
  });
});

describe('when the account itself has trouble', () => {
  test('its own account unreachable: shared cars still sync', async () => {
    const { world, partner, car } = await sharedCar();
    world.remoteFor(PARTNER.uid).failPull = true;
    const result = await partner.sync();
    expect(result.own.ok).toBe(false);
    expect(result.shares.synced.map((m) => m.vehicleId)).toEqual([car.id]);
    expect(await partner.store.fillUps(car.id)).toHaveLength(1);
  });

  test('its own account refused: nothing shared is attempted, and nothing is forgotten', async () => {
    const { world, partner, car } = await sharedCar();
    await partner.sync();
    const own = world.remoteFor(PARTNER.uid);
    own.pull = () => Promise.reject(new Refused('not on the allowlist'));
    const result = await partner.sync();
    expect(result.own.ok === false && result.own.kind).toBe('refused');
    expect(result.shares.synced).toHaveLength(0);
    expect(result.shares.ended).toHaveLength(0);
    expect(await partner.store.fillUps(car.id)).toHaveLength(1);
  });

  test('without sharing at all, it is the ordinary sync', async () => {
    const world = new InMemorySharingWorld();
    const store = new FuelTrackerStore({
      vehicles: new InMemoryRepository<VehicleRecord>(),
      fillUps: new InMemoryRepository<FillUpRecord>(),
      pendingFillUps: new InMemoryRepository<PendingFillUpRecord>(),
    });
    const car = await store.addVehicle({ name: 'Solo' });
    const result = await syncAll(store, world.remoteFor('solo'), null, new MonotonicClock(), new InMemorySyncState());
    expect(result.own.ok).toBe(true);
    expect(result.shares).toEqual({ synced: [], ended: [], failed: [], unreachable: false });
    expect((await rowsIn(world, 'solo')).vehicles).toEqual([car.id]);
  });
});

describe('the ledger', () => {
  test('records the cars this device holds, and drops one that ends', async () => {
    const { owner, partner, car } = await sharedCar();
    await partner.sync();
    expect((await partner.sharing.ledger.load()).map((m) => m.vehicleId)).toEqual([car.id]);
    await owner.sharing.remote.removeMember(car.id, PARTNER.uid);
    await partner.sync();
    expect(await partner.sharing.ledger.load()).toEqual([]);
  });

  test('a ledger that cannot be read is treated as empty, not as a failure', async () => {
    const { partner, car } = await sharedCar();
    partner.sharing.ledger.load = () => Promise.reject(new Error('storage blocked'));
    const result = await partner.sync();
    expect(result.own.ok).toBe(true);
    expect(result.shares.synced.map((m) => m.vehicleId)).toEqual([car.id]);
  });
});

describe('over time', () => {
  test('rejoining after leaving brings the car and its history back', async () => {
    const { owner, partner, car } = await sharedCar();
    await partner.sync();
    const [membership] = await partner.sharing.remote.memberships();
    await partner.sharing.remote.leave(membership!);
    await partner.sync();
    expect(await partner.store.vehicles()).toHaveLength(0);

    await partner.sharing.remote.accept(await owner.sharing.remote.invite(car, PARTNER.email));
    await partner.sync();
    expect((await partner.store.vehicles()).map((v) => v.name)).toEqual(['Civic']);
    expect(await partner.store.fillUps(car.id)).toHaveLength(1);
  });

  test('a second sync with nothing new reads nothing new', async () => {
    const { partner } = await sharedCar();
    const reads: number[] = [];
    const realScoped = partner.sharing.remote.scoped.bind(partner.sharing.remote);
    partner.sharing.remote.scoped = (membership) => {
      const remote = realScoped(membership);
      return {
        pull: async (since) => {
          const raw = await remote.pull(since);
          reads.push(raw.fillUps.length);
          return raw;
        },
        push: (snapshot) => remote.push(snapshot),
      };
    };
    await partner.sync();
    await partner.sync();
    expect(reads).toEqual([1, 0]);
  });

  test('the owner deletes a fill-up the partner is correcting: both end up agreeing', async () => {
    // This test was flaky — 11 runs in 12 failed — until ties were broken
    // deterministically (syncTies.test.ts reproduces it without timing).
    const { owner, partner, car } = await sharedCar();
    await partner.sync();
    const [entry] = await owner.store.fillUps(car.id);
    await partner.store.updateFillUp(entry!.id, draft(10_020), car.id);
    await owner.store.removeFillUp(entry!.id);
    await owner.sync();
    await partner.sync();
    await owner.sync();
    await partner.sync();
    const ids = async (d: Device): Promise<string[]> => (await d.store.fillUps(car.id)).map((f) => f.id);
    expect(await ids(partner)).toEqual(await ids(owner));
  });

  test('a fill-up logged just before being removed is forgotten with the car, and never reaches the owner', async () => {
    // Access ended before it was sent; the rules would refuse it now. Said
    // plainly in the docs: an unsynced entry on a car you lose goes with it.
    const { world, owner, partner, car } = await sharedCar();
    await partner.sync();
    const late = await partner.store.addFillUp(draft(10_300), car.id);
    await owner.sharing.remote.removeMember(car.id, PARTNER.uid);
    const result = await partner.sync();
    expect(result.shares.ended).toHaveLength(1);
    expect(await partner.store.fillUp(late.id)).toBeUndefined();
    expect((await rowsIn(world, OWNER.uid)).fillUps).not.toContain(late.id);
    expect((await rowsIn(world, PARTNER.uid)).fillUps).not.toContain(late.id);
  });

  test('the owner’s view is never changed by the partner forgetting', async () => {
    const { world, owner, partner, car } = await sharedCar();
    await partner.sync();
    await partner.store.addFillUp(draft(10_300), car.id);
    await partner.sync();
    const before = await rowsIn(world, OWNER.uid);
    const [membership] = await partner.sharing.remote.memberships();
    await partner.sharing.remote.leave(membership!);
    await partner.sync();
    await owner.sync();
    expect(await rowsIn(world, OWNER.uid)).toEqual(before);
    expect(await owner.store.fillUps(car.id)).toHaveLength(2);
  });
});
