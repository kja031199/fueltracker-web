import { describe, expect, test } from 'vitest';
import { InMemoryRepository } from './repository';
import type { FillUpRecord, PendingFillUpRecord, VehicleRecord } from './records';
import { FuelTrackerStore } from './store';
import { InMemorySharingWorld, type Account } from './sharing';
import { syncAll, type SharingSync } from './shareSync';
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
