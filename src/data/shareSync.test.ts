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
    await owner.store.updateFillUp(first!.id, draft(10_050));
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
    await partner.store.updateFillUp(first!.id, draft(10_010));
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

  test('hands back the shared cars it read, so nothing reads them again (#89)', async () => {
    const { partner, car } = await sharedCar();
    const result = await partner.sync();
    expect(result.shares.memberships?.map((m) => m.vehicleId)).toEqual([car.id]);
  });

  test('hands back null, not an empty list, when it could not read them', async () => {
    const { partner } = await sharedCar();
    partner.sharing.remote.memberships = () => Promise.reject(new Error('offline'));
    const result = await partner.sync();
    expect(result.shares.memberships).toBeNull();
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
    expect(result.shares).toEqual({ synced: [], ended: [], failed: [], rejected: [], outcomes: [], unreachable: false, memberships: null, clashed: [] });
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

  // #77. The ledger is what keeps a shared car out of the account's own push
  // when the membership list cannot say. Reading a failure as "nothing is
  // shared" copied the owner's car — other people's fill-ups, receipts and
  // notes — into the member's own account.
  test('a ledger that cannot be read stops the sync, rather than reading as "nothing is shared"', async () => {
    const { world, partner, car } = await sharedCar();
    await partner.sync();
    partner.sharing.ledger.load = () => Promise.reject(new Error('storage blocked'));
    partner.sharing.remote.memberships = async () => {
      throw new Error('offline');
    };
    await partner.store.addFillUp(draft(10_400), car.id);

    const result = await partner.sync();

    expect(result.own.ok).toBe(false);
    expect(!result.own.ok && result.own.kind).toBe('unreachable');
    expect(await rowsIn(world, PARTNER.uid)).toEqual({ vehicles: [], fillUps: [] });
    // Nothing was forgotten on the strength of a failed read either.
    expect(await partner.store.fillUps(car.id)).toHaveLength(2);
  });

  test('…even when the membership list can be read: a car left elsewhere is still on this device', async () => {
    const { world, partner, car } = await sharedCar();
    await partner.sync();
    // Left on another device: no longer in the list, still in this store.
    const [membership] = await partner.sharing.remote.memberships();
    if (membership === undefined) throw new Error('no membership');
    await world.sharingFor(PARTNER).leave(membership);
    partner.sharing.ledger.load = () => Promise.reject(new Error('storage blocked'));

    const result = await partner.sync();

    expect(result.own.ok).toBe(false);
    expect(await rowsIn(world, PARTNER.uid)).toEqual({ vehicles: [], fillUps: [] });
    expect(await partner.store.fillUps(car.id)).toHaveLength(1);
  });

  test('once the ledger can be read again, the next sync carries on as normal', async () => {
    const { world, partner, car } = await sharedCar();
    await partner.sync();
    const load = partner.sharing.ledger.load.bind(partner.sharing.ledger);
    partner.sharing.ledger.load = () => Promise.reject(new Error('storage blocked'));
    expect((await partner.sync()).own.ok).toBe(false);
    partner.sharing.ledger.load = load;

    const result = await partner.sync();

    expect(result.own.ok).toBe(true);
    expect(result.shares.synced.map((m) => m.vehicleId)).toEqual([car.id]);
    expect(await rowsIn(world, PARTNER.uid)).toEqual({ vehicles: [], fillUps: [] });
  });

  test('a share is recorded before any of its rows arrive, so a failed final save leaves nothing unrecorded', async () => {
    const { world, partner, car } = await sharedCar();
    // The save after the shared rows are pulled fails — or the tab closes
    // there. Without the earlier save, those rows would be on this device
    // with no record that they are someone else's.
    const save = partner.sharing.ledger.save.bind(partner.sharing.ledger);
    partner.sharing.ledger.save = async (list) => {
      if ((await partner.store.fillUps(car.id)).length > 0) throw new Error('storage blocked');
      await save(list);
    };
    await partner.sync();
    expect(await partner.store.fillUps(car.id)).toHaveLength(1);
    expect((await partner.sharing.ledger.load()).map((m) => m.vehicleId)).toEqual([car.id]);

    // Next time the list cannot be read: the ledger alone must keep the car out.
    partner.sharing.ledger.save = save;
    partner.sharing.remote.memberships = async () => {
      throw new Error('offline');
    };
    await partner.store.addFillUp(draft(10_400), car.id);
    await partner.sync();
    expect(await rowsIn(world, PARTNER.uid)).toEqual({ vehicles: [], fillUps: [] });
  });

  test('a share that ended stays in the ledger until its rows are actually gone', async () => {
    const { world, partner, car } = await sharedCar();
    await partner.sync();
    const [membership] = await partner.sharing.remote.memberships();
    if (membership === undefined) throw new Error('no membership');
    await world.sharingFor(PARTNER).leave(membership);
    // Interrupted between recording and forgetting: the tab closes, storage fails.
    const forget = partner.store.forgetVehicle.bind(partner.store);
    partner.store.forgetVehicle = () => Promise.reject(new Error('interrupted'));
    await expect(partner.sync()).rejects.toThrow('interrupted');
    expect(await partner.store.fillUps(car.id)).toHaveLength(1);

    // Its rows are still here, so the ledger must still keep them out.
    partner.store.forgetVehicle = forget;
    partner.sharing.remote.memberships = async () => {
      throw new Error('offline');
    };
    await partner.sync();
    expect(await rowsIn(world, PARTNER.uid)).toEqual({ vehicles: [], fillUps: [] });
  });

  test('a share that cannot be recorded is not pulled: nothing arrives that the ledger does not know about', async () => {
    const { partner, car } = await sharedCar();
    partner.sharing.ledger.save = () => Promise.reject(new Error('storage blocked'));

    const result = await partner.sync();

    expect(result.shares.synced).toEqual([]);
    expect(result.shares.failed.map((m) => m.vehicleId)).toEqual([car.id]);
    expect(await partner.store.vehicles()).toHaveLength(0);
    expect(await partner.store.fillUps(car.id)).toHaveLength(0);
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
    await partner.store.updateFillUp(entry!.id, draft(10_020));
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

// --- #78: an invitation to a car that has the id of one of yours -------------

describe('a share whose car id is already one of yours (#78)', () => {
  /**
   * The attack in #78. The victim's own car id leaks — request links and CSV
   * exports carry it. The inviter files a car of their own under that id and
   * invites the victim. Before the fix, accepting excluded the victim's own car
   * from their own sync and ran a share sync for it, which pushed the victim's
   * fill-ups (receipts included) into the inviter's account, and leaving the
   * share later hard-deleted the victim's own car from their device.
   */
  async function clash(): Promise<{
    world: InMemorySharingWorld;
    owner: Device;
    victim: Device;
    mine: VehicleRecord;
  }> {
    const world = new InMemorySharingWorld();
    const owner = device(world, OWNER);
    const victim = device(world, PARTNER);
    const mine = await victim.store.addVehicle({ name: 'My Civic' });
    await victim.store.addFillUp(draft(20_000), mine.id);
    await victim.sync();
    // The inviter files a car under the leaked id, in their own tree.
    await world.remoteFor(OWNER.uid).push({
      vehicles: [{ ...mine, name: 'Bait', updatedAt: mine.updatedAt + 1_000_000 }],
      fillUps: [],
      pendingFillUps: [],
    });
    return { world, owner, victim, mine };
  }

  function forceMembership(world: InMemorySharingWorld, vehicleId: string): void {
    // Stands in for a membership that got past every check — accepted on a
    // device that had not synced the car yet, say.
    const key = `${OWNER.uid}__${vehicleId}`;
    world.members.set(key, new Map([[PARTNER.uid, { uid: PARTNER.uid, name: 'Sam', email: 'sam@example.com', joinedAt: 1 }]]));
    world.memberships.set(PARTNER.uid, new Map([[key, { ownerUid: OWNER.uid, vehicleId, ownerName: 'Kyle', vehicleName: 'Bait' }]]));
  }

  test('the account refuses the join, as the rules do', async () => {
    const { world, owner, victim, mine } = await clash();
    const invite = await owner.sharing.remote.invite({ id: mine.id, name: 'Bait' }, 'sam@example.com');
    await expect(victim.sharing.remote.accept(invite)).rejects.toBeInstanceOf(Refused);
    expect(world.isMember(OWNER.uid, mine.id, PARTNER.uid)).toBe(false);
  });

  test('…including when your car with that id was deleted: its tombstone still names it', async () => {
    const { owner, victim, mine } = await clash();
    await victim.store.removeVehicle(mine.id);
    await victim.sync();
    const invite = await owner.sharing.remote.invite({ id: mine.id, name: 'Bait' }, 'sam@example.com');
    await expect(victim.sharing.remote.accept(invite)).rejects.toBeInstanceOf(Refused);
  });

  test('a clashing membership that exists anyway is never synced: nothing of yours reaches the inviter', async () => {
    const { world, victim, mine } = await clash();
    forceMembership(world, mine.id);

    const result = await victim.sync();

    expect(result.shares.clashed.map((m) => m.vehicleId)).toEqual([mine.id]);
    expect(result.shares.synced).toEqual([]);
    expect((await rowsIn(world, OWNER.uid)).fillUps).toEqual([]);
    // Your car is untouched, and not taken over by the inviter's record.
    expect((await victim.store.vehicles()).map((v) => v.name)).toEqual(['My Civic']);
    expect(await victim.store.fillUps(mine.id)).toHaveLength(1);
    // Never recorded as held for someone else.
    expect(await victim.sharing.ledger.load()).toEqual([]);
  });

  test('a car of yours deleted on this device still clashes: its tombstone names it', async () => {
    const { world, victim, mine } = await clash();
    await victim.store.removeVehicle(mine.id);
    forceMembership(world, mine.id);

    const result = await victim.sync();

    expect(result.shares.clashed.map((m) => m.vehicleId)).toEqual([mine.id]);
    expect((await rowsIn(world, OWNER.uid)).fillUps).toEqual([]);
  });

  test('a clash is never written to the ledger, even by a sync that is interrupted', async () => {
    // Recorded, it would read as a known share next time — and be synced.
    const { world, victim, mine } = await clash();
    forceMembership(world, mine.id);
    const save = victim.sharing.ledger.save.bind(victim.sharing.ledger);
    let saves = 0;
    victim.sharing.ledger.save = async (list) => {
      saves += 1;
      await save(list);
      if (saves === 1) throw new Error('interrupted after the first save');
    };
    await victim.sync();
    victim.sharing.ledger.save = save;

    const result = await victim.sync();

    expect(result.shares.clashed.map((m) => m.vehicleId)).toEqual([mine.id]);
    expect((await rowsIn(world, OWNER.uid)).fillUps).toEqual([]);
  });

  test('leaving the clashing share does not delete your own car', async () => {
    const { world, victim, mine } = await clash();
    forceMembership(world, mine.id);
    await victim.sync();
    const [membership] = await victim.sharing.remote.memberships();
    if (membership === undefined) throw new Error('no membership');
    await victim.sharing.remote.leave(membership);

    const result = await victim.sync();

    expect(result.shares.ended).toEqual([]);
    expect(await victim.store.fillUps(mine.id)).toHaveLength(1);
    expect((await victim.store.vehicles()).map((v) => v.id)).toEqual([mine.id]);
  });

  test('a car that arrived through a share is not mistaken for a clash on the next sync', async () => {
    const { partner, car } = await sharedCar();
    await partner.sync();
    const result = await partner.sync();
    expect(result.shares.clashed).toEqual([]);
    expect(result.shares.synced.map((m) => m.vehicleId)).toEqual([car.id]);
  });
});

// --- #79: a far-future stamp ------------------------------------------------------

describe('a member cannot lock the owner’s fill-up with a far-future stamp (#79)', () => {
  test('the account refuses it, and the owner’s edits and deletions still win', async () => {
    const { world, owner, partner, car } = await sharedCar();
    await partner.sync();
    const [theirs] = await partner.store.fillUps(car.id);
    if (theirs === undefined) throw new Error('no fill-up');
    const whole = await partner.store.fillUp(theirs.id);
    if (whole === undefined) throw new Error('no fill-up');
    const [membership] = await partner.sharing.remote.memberships();
    if (membership === undefined) throw new Error('no membership');

    // Written straight to the account, as a modified client could.
    const locked = { ...whole, odometer: 99_999, updatedAt: Date.now() + 365 * 24 * 60 * 60 * 1000 };
    await expect(
      partner.sharing.remote.scoped(membership).push({ vehicles: [], fillUps: [locked], pendingFillUps: [] }),
    ).rejects.toBeInstanceOf(Refused);

    // The owner can still change it, and the change reaches the partner.
    await owner.sync();
    await owner.store.updateFillUp(theirs.id, draft(10_123));
    await owner.sync();
    await partner.sync();
    expect((await partner.store.fillUp(theirs.id))?.odometer).toBe(10_123);
    expect(((await world.remoteFor(OWNER.uid).pull(null)).fillUps as FillUpRecord[]).find((f) => f.id === theirs.id)?.odometer).toBe(10_123);
  });

  test('nor take its stamp backwards', async () => {
    const { partner, car } = await sharedCar();
    await partner.sync();
    const [theirs] = await partner.store.fillUps(car.id);
    const whole = theirs === undefined ? undefined : await partner.store.fillUp(theirs.id);
    if (whole === undefined) throw new Error('no fill-up');
    const [membership] = await partner.sharing.remote.memberships();
    if (membership === undefined) throw new Error('no membership');
    await expect(
      partner.sharing.remote
        .scoped(membership)
        .push({ vehicles: [], fillUps: [{ ...whole, odometer: 99_999, updatedAt: whole.updatedAt - 1 }], pendingFillUps: [] }),
    ).rejects.toBeInstanceOf(Refused);
  });
});

// --- #80: ending access holds ------------------------------------------------------

describe('ending a share holds on the account side (#80)', () => {
  test('removing a member withdraws an invitation left behind, so they cannot join again', async () => {
    const { world, owner, partner, car } = await sharedCar();
    // As an older build could leave it: joined, and the invitation still there.
    const leftover = await owner.sharing.remote.invite(car, 'sam@example.com');
    await owner.sharing.remote.removeMember(car.id, PARTNER.uid);
    expect(world.invites.size).toBe(0);
    await expect(partner.sharing.remote.accept(leftover)).rejects.toBeInstanceOf(Refused);
    expect(world.isMember(OWNER.uid, car.id, PARTNER.uid)).toBe(false);
  });

  test('once the owner deletes the car, the member can neither read nor write it, and forgets it', async () => {
    const { owner, partner, car } = await sharedCar();
    await partner.sync();
    const [membership] = await partner.sharing.remote.memberships();
    if (membership === undefined) throw new Error('no membership');
    await owner.store.removeVehicle(car.id);
    await owner.sync();

    await expect(partner.sharing.remote.scoped(membership).pull(null)).rejects.toBeInstanceOf(Refused);
    await expect(
      partner.sharing.remote.scoped(membership).push({ vehicles: [], fillUps: [], pendingFillUps: [] }),
    ).rejects.toBeInstanceOf(Refused);
    await expect(partner.sharing.remote.members(OWNER.uid, car.id)).rejects.toBeInstanceOf(Refused);

    const result = await partner.sync();
    expect(result.shares.ended.map((m) => m.vehicleId)).toEqual([car.id]);
    expect(await partner.store.vehicles()).toHaveLength(0);
  });

  test('an invitation to a car deleted since it was sent cannot be accepted', async () => {
    const world = new InMemorySharingWorld();
    const owner = device(world, OWNER);
    const partner = device(world, PARTNER);
    const car = await owner.store.addVehicle({ name: 'Civic' });
    await owner.sync();
    const invite = await owner.sharing.remote.invite(car, 'sam@example.com');
    await owner.store.removeVehicle(car.id);
    await owner.sync();
    await expect(partner.sharing.remote.accept(invite)).rejects.toBeInstanceOf(Refused);
  });

  test('ending sharing of a car removes its members and invitations, and leaves other cars alone', async () => {
    const { world, owner, car } = await sharedCar();
    const other = await owner.store.addVehicle({ name: 'Truck' });
    await owner.sync();
    await owner.sharing.remote.invite(car, 'alex@example.com');
    await owner.sharing.remote.invite(other, 'alex@example.com');
    await owner.sharing.remote.endSharing(car.id);
    expect(world.isMember(OWNER.uid, car.id, PARTNER.uid)).toBe(false);
    expect([...world.invites.values()].map((i) => i.vehicleId)).toEqual([other.id]);
  });
});

// --- #84: what a shared car's sync reports ---------------------------------------

describe('a shared car’s sync is reported, not thrown away (#84)', () => {
  /** A fill-up on the shared car the owner's account will refuse: entered by someone else. */
  async function plantRefusable(partner: Device, carId: string): Promise<string> {
    const [theirs] = await partner.store.fillUps(carId);
    const whole = theirs === undefined ? undefined : await partner.store.fillUp(theirs.id);
    if (whole === undefined) throw new Error('no fill-up');
    await partner.store.importBackup({
      vehicles: [],
      fillUps: [{ ...whole, id: 'planted', enteredBy: 'someone-else', updatedAt: Date.now() }],
      pendingFillUps: [],
    });
    return 'planted';
  }

  test('an upload the owner’s account refuses is "rejected" — about the data — not "could not be reached"', async () => {
    const { partner, car } = await sharedCar();
    await partner.sync();
    await plantRefusable(partner, car.id);

    const result = await partner.sync();

    expect(result.shares.rejected.map((m) => m.vehicleId)).toEqual([car.id]);
    expect(result.shares.failed).toEqual([]);
    // Not forgotten: a refused upload is not the share ending.
    expect(result.shares.ended).toEqual([]);
    expect(await partner.store.vehicles()).toHaveLength(1);
  });

  test('a share that cannot be reached is still "failed", and only that', async () => {
    const { world, partner, car } = await sharedCar();
    await partner.sync();
    world.remoteFor(OWNER.uid).failPull = true;

    const result = await partner.sync();

    expect(result.shares.failed.map((m) => m.vehicleId)).toEqual([car.id]);
    expect(result.shares.rejected).toEqual([]);
  });

  test('what each shared car’s sync reported is kept — a photo too large to send, say', async () => {
    const { world, partner, car } = await sharedCar();
    await partner.sync();
    world.remoteFor(OWNER.uid).receiptByteLimit = 10;
    const made = makeFuelEntryDraft({
      date: new Date(2026, 0, 3),
      odometer: 10_400,
      gallons: 10,
      pricePerGallon: 3.5,
      receiptImageData: new Uint8Array(500),
    });
    if (made === null) throw new Error('fixture draft failed validation');
    await partner.store.addFillUp(made, car.id);

    const result = await partner.sync();

    expect(result.shares.synced.map((m) => m.vehicleId)).toEqual([car.id]);
    expect(result.shares.outcomes.map((o) => o.pushed.receiptsOmitted)).toEqual([1]);
  });
});
