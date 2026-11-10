// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { draft, makeStore, sharingFor } from '../test/fixtures';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { FuelTrackerStore } from '../data/store';
import { InMemorySharingWorld, type Account } from '../data/sharing';
import type { SharingSync } from '../data/shareSync';
import { FuelLogProvider, useFuelLog, useSyncStatus, type FuelLog } from './fuelLog';
import type { SyncStatus } from './useSync';
import { FillUpsScreen } from './FillUpsScreen';

/**
 * Sharing reads on the free plan (#89), where reads are what runs out.
 *
 * Every sync used to read the account's shared cars twice — once in the sync,
 * once more for the screens — and the fill-up list asked who a car is shared
 * with again, even for a car nobody shares.
 */

afterEach(cleanup);

const ME: Account = { uid: 'u1', name: 'Kyle', email: 'kyle@example.com', emailVerified: true };
const THEM: Account = { uid: 'u2', name: 'Sam', email: 'sam@example.com', emailVerified: true };

/**
 * After a sync, the sharing lists are re-read; this waits for that read —
 * counted by the world — and lets React apply it. Not a sleep (#97).
 */
async function refreshed(world: InMemorySharingWorld, after: number): Promise<void> {
  await waitFor(() => expect(world.reads.invitesForMe).toBeGreaterThan(after));
  await act(async () => {});
}

interface Mounted {
  readonly log: () => FuelLog;
  readonly status: () => SyncStatus;
  readonly world: InMemorySharingWorld;
}

/** The app's provider for `account`, showing the fill-up list, once the mount sync has settled. */
async function mount(
  world: InMemorySharingWorld,
  account: Account,
  store: FuelTrackerStore,
  sharing: SharingSync = sharingFor(world, account),
): Promise<Mounted> {
  let log: FuelLog | null = null;
  let status: SyncStatus | null = null;
  function Probe(): null {
    log = useFuelLog();
    status = useSyncStatus();
    return null;
  }
  const before = world.reads.invitesForMe;
  render(
    <FuelLogProvider store={store} remote={world.remoteFor(account.uid)} uid={account.uid} sharing={sharing}>
      <Probe />
      <FillUpsScreen />
    </FuelLogProvider>,
  );
  await waitFor(() => expect(status!.lastSyncedAt).not.toBeNull());
  await waitFor(() => expect(status!.syncing).toBe(false));
  await refreshed(world, before);
  return { log: () => log!, status: () => status!, world };
}

async function syncAgain(mounted: Mounted): Promise<void> {
  const before = mounted.world.reads.invitesForMe;
  await act(async () => {
    await mounted.status().syncNow();
  });
  await refreshed(mounted.world, before);
}

describe('a sync that changes nothing (#89)', () => {
  test('reads the shared cars once, and asks who a car nobody shares is shared with never', async () => {
    const world = new InMemorySharingWorld();
    const store = makeStore({ author: ME.uid });
    const car = await store.addVehicle({ name: 'Civic' });
    await store.addFillUp(draft(10_000), car.id);
    const mounted = await mount(world, ME, store);
    await screen.findByText(/10,000/);

    world.reads.memberships = 0;
    world.reads.members = 0;
    await syncAgain(mounted);
    await syncAgain(mounted);

    expect(world.reads.memberships).toBe(2);
    expect(world.reads.members).toBe(0);
  });

  test('on a car shared with you, does not reload the screens', async () => {
    const world = new InMemorySharingWorld();
    // The owner's car, in the owner's account, shared with this account.
    const owner = makeStore({ author: THEM.uid });
    const car = await owner.addVehicle({ name: 'Jazz' });
    await owner.addFillUp(draft(20_000), car.id);
    const ownerSnapshot = await owner.exportSnapshot();
    await world.remoteFor(THEM.uid).push(ownerSnapshot);
    await world.sharingFor(ME).accept(await world.sharingFor(THEM).invite(car, ME.email));

    const store = makeStore({ author: ME.uid });
    const mounted = await mount(world, ME, store);
    await waitFor(() => expect(mounted.log().vehicles.map((v) => v.id)).toEqual([car.id]));

    const reads = vi.spyOn(store, 'vehicles');
    await syncAgain(mounted);

    // The shared car synced, and brought nothing: nothing to show again.
    expect(reads).not.toHaveBeenCalled();
  });
});

describe('the cars shared with you, as the screens see them (#89)', () => {
  test('come from what the sync read — a share it would not record is still listed, so it can be left', async () => {
    const world = new InMemorySharingWorld();
    const store = makeStore({ author: ME.uid });
    const mine = await store.addVehicle({ name: 'Civic' });
    // Somebody shares a car whose id is already one of this device's (#78):
    // the sync leaves it out of the device's ledger, and says to leave it.
    await world.remoteFor(THEM.uid).push({ vehicles: [{ ...mine, name: 'Their Civic' }], fillUps: [], pendingFillUps: [] });
    await world.sharingFor(ME).accept(await world.sharingFor(THEM).invite({ id: mine.id, name: 'Their Civic' }, ME.email));

    const mounted = await mount(world, ME, store);

    expect(mounted.status().message).toMatch(/already yours/i);
    expect(mounted.log().sharing.sharedWithMe.map((m) => m.vehicleName)).toEqual(['Their Civic']);
  });
});

describe('who entered each fill-up (#89)', () => {
  test('is asked once per car, and again only when a fill-up names somebody new', async () => {
    const world = new InMemorySharingWorld();
    const store = makeStore({ author: ME.uid });
    const car = await store.addVehicle({ name: 'Civic' });
    const mounted = await mount(world, ME, store);
    const { sharing } = mounted.log();

    // The list on screen has asked once already: nobody shares it, and that
    // is remembered.
    expect(world.reads.members).toBe(1);
    world.reads.members = 0;
    expect(await sharing.namesFor(car.id, [ME.uid])).toBeNull();
    expect(await sharing.namesFor(car.id, [ME.uid, null])).toBeNull();
    expect(world.reads.members).toBe(0);

    // Somebody joins, and logs a fill-up: their uid is new, so it is asked again.
    await world.remoteFor(ME.uid).push(await store.exportSnapshot());
    await world.sharingFor(THEM).accept(await world.sharingFor(ME).invite(car, THEM.email));
    const names = await sharing.namesFor(car.id, [ME.uid, THEM.uid]);
    expect(world.reads.members).toBe(1);
    expect(names?.get(THEM.uid)).toBe('Sam');
    expect(names?.get(ME.uid)).toBe('you');

    // Known now: no more reads.
    await sharing.namesFor(car.id, [THEM.uid]);
    expect(world.reads.members).toBe(1);

    // A uid that is nobody's (a member since removed) is asked about once, not on every sync.
    await sharing.namesFor(car.id, ['gone']);
    await sharing.namesFor(car.id, ['gone']);
    expect(world.reads.members).toBe(2);
  });
});

describe('invitations sent for one car (#89)', () => {
  test('are read for that car only', async () => {
    const world = new InMemorySharingWorld();
    const store = makeStore({ author: ME.uid });
    const civic = await store.addVehicle({ name: 'Civic' });
    const jazz = await store.addVehicle({ name: 'Jazz' });
    await world.remoteFor(ME.uid).push(await store.exportSnapshot());
    const remote = world.sharingFor(ME);
    await remote.invite(civic, 'a@example.com');
    await remote.invite(jazz, 'b@example.com');

    expect((await remote.invitesSent(civic.id)).map((invite) => invite.email)).toEqual(['a@example.com']);
    expect((await remote.invitesSent()).map((invite) => invite.email).sort()).toEqual(['a@example.com', 'b@example.com']);
  });
});

describe('a shared car read in full while its index builds (#89)', () => {
  test('is said, once, in what the sync reports', async () => {
    const world = new InMemorySharingWorld();
    const store = makeStore({ author: ME.uid });
    await store.addVehicle({ name: 'Civic' });
    const sharing = sharingFor(world, ME);
    // Every shared car's read falls back; two cars, one note.
    const scopedTo = sharing.remote.scoped.bind(sharing.remote);
    sharing.remote.scoped = (membership) => {
      const scoped = scopedTo(membership);
      return { pull: async (since) => ({ ...(await scoped.pull(since)), indexMissing: true }), push: (rows) => scoped.push(rows) };
    };
    for (const name of ['Jazz', 'Golf']) {
      const owner = makeStore({ author: THEM.uid });
      const car = await owner.addVehicle({ name });
      await world.remoteFor(THEM.uid).push(await owner.exportSnapshot());
      await world.sharingFor(ME).accept(await world.sharingFor(THEM).invite(car, ME.email));
    }

    const mounted = await mount(world, ME, store, sharing);

    const message = mounted.status().message ?? '';
    expect(message.match(/index/gi)?.length).toBe(1);
    expect(message).toMatch(/read in full/i);
  });
});
