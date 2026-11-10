import { describe, expect, test } from 'vitest';
import { draft, makeStore } from '../test/fixtures';
import type { ReactElement } from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { InMemoryRepository } from '../data/repository';
import type { FillUpRecord, PendingFillUpRecord, VehicleRecord } from '../data/records';
import { InMemoryRemoteStore } from '../data/remote';
import { FuelTrackerStore } from '../data/store';
import { FuelLogProvider, useFuelLog, useSyncStatus, type FuelLog } from './fuelLog';
import type { SyncStatus } from './useSync';
import { manualTimers } from '../test/manualTimers';
import { InMemorySharingWorld } from '../data/sharing';
import type { SharingSync } from '../data/shareSync';
import { InMemorySyncState } from '../data/syncState';
import { InMemoryShareLedger } from '../data/shareLedger';
import type { FillUpSummary } from '../data/records';

/**
 * What a save costs the screens (#88).
 *
 * The context value used to be rebuilt on every render of the provider — two
 * of its inputs were fresh objects each time — so every screen re-rendered on
 * every state change anywhere: each of the three reads of a reload, the
 * selected car's fill-ups arriving one effect later, and each step of the sync
 * that follows a save. About ten commits of the whole tree per fill-up, and
 * for a moment the selected car and the fill-ups shown were different cars'.
 */

/**
 * Lets React apply what has already resolved. Not a sleep (#97): every test
 * here first waits for the thing it is about to count past — a sync finished,
 * a read made — so there is nothing left to wait for but the render.
 */
async function settle(): Promise<void> {
  await act(async () => {});
}

async function remoteHolds(remote: InMemoryRemoteStore, id: string): Promise<boolean> {
  const before = remote.pullLog.length;
  const snapshot = await remote.pull();
  remote.pullLog.length = before;
  return snapshot.fillUps.some((row) => (row as { id?: unknown }).id === id);
}

interface SharingCase {
  readonly sharing: SharingSync | null;
  /** How many times the sharing lists have been re-read — once after each sync. None without sharing. */
  readonly refreshes: () => number;
}

function sharingOff(): SharingCase {
  return { sharing: null, refreshes: () => 0 };
}

function sharingOn(): SharingCase {
  const world = new InMemorySharingWorld();
  return {
    sharing: {
      remote: world.sharingFor({ uid: 'u1', name: 'Me', email: 'me@example.com', emailVerified: true }),
      stateFor: () => new InMemorySyncState(),
      forgetState: async () => {},
      ledger: new InMemoryShareLedger(),
    },
    refreshes: () => world.reads.invitesForMe,
  };
}

describe('a save (#88)', () => {
  const cases: [string, () => SharingCase][] = [
    ['without sharing', sharingOff],
    // The sharing lists are re-read after every sync; the same lists again
    // must not count as a change.
    ['with sharing', sharingOn],
  ];
  test.each(cases)('re-renders a screen that shows only the vehicles once, sync included (%s)', async (_name, sharingCase) => {
    const { sharing, refreshes } = sharingCase();
    const timers = manualTimers();
    let status: SyncStatus | null = null;
    const store = makeStore();
    const car = await store.addVehicle({ name: 'Civic' });
    const remote = new InMemoryRemoteStore();
    let renders = 0;
    let log: FuelLog | null = null;

    function VehiclesOnly(): ReactElement {
      const { vehicles } = useFuelLog();
      renders += 1;
      return <p>{vehicles.length}</p>;
    }
    function Actions(): null {
      log = useFuelLog();
      status = useSyncStatus();
      return null;
    }

    render(
      <FuelLogProvider store={store} remote={remote} uid="u1" sharing={sharing} syncTimers={timers}>
        <VehiclesOnly />
        <Actions />
      </FuelLogProvider>,
    );
    // Loaded, the mount sync done and its sharing refresh read, before counting.
    await waitFor(() => expect(remote.pullLog.length).toBeGreaterThan(0));
    await waitFor(() => expect(status!.syncing).toBe(false));
    if (sharing !== null) await waitFor(() => expect(refreshes()).toBeGreaterThan(0));
    await settle();
    renders = 0;
    const refreshedBefore = refreshes();

    let saved: FillUpRecord | null = null;
    await act(async () => {
      saved = await log!.addFillUp(draft(10_000), car.id);
    });
    // The sync a save schedules, run now rather than after its 1.5 s delay,
    // and the sharing refresh after it.
    expect(timers.pending()).toBe(1);
    await act(async () => {
      timers.fire();
    });
    await waitFor(async () => expect(await remoteHolds(remote, saved!.id)).toBe(true));
    await waitFor(() => expect(status!.syncing).toBe(false));
    if (sharing !== null) await waitFor(() => expect(refreshes()).toBeGreaterThan(refreshedBefore));
    await settle();

    // Once: the reload that shows the save. Not the sync, not its status.
    expect(renders).toBe(1);
  });
});

describe('what the screens are shown (#88)', () => {
  test('the fill-ups shown always belong to the selected car — through a delete and a switch', async () => {
    const store = makeStore();
    const first = await store.addVehicle({ name: 'Civic' });
    const second = await store.addVehicle({ name: 'Jazz' });
    await store.addFillUp(draft(10_000), first.id);
    await store.addFillUp(draft(10_300), first.id);
    await store.addFillUp(draft(50_000), second.id);
    const mismatches: string[] = [];
    let log: FuelLog | null = null;

    function Probe(): null {
      log = useFuelLog();
      const { selectedVehicleId, fillUps } = log;
      for (const row of fillUps) {
        if (row.vehicleId !== selectedVehicleId) {
          mismatches.push(`showing ${selectedVehicleId} with a fill-up of ${row.vehicleId}`);
        }
      }
      return null;
    }

    render(
      <FuelLogProvider store={store} remote={null} uid={null}>
        <Probe />
      </FuelLogProvider>,
    );
    await waitFor(() => expect(log!.fillUps).toHaveLength(2));

    await act(async () => {
      log!.selectVehicle(second.id);
    });
    await waitFor(() => expect(log!.fillUps).toHaveLength(1));
    await act(async () => {
      log!.selectVehicle(first.id);
    });
    await waitFor(() => expect(log!.fillUps).toHaveLength(2));

    // Deleting the selected car moves the selection to the other one.
    await act(async () => {
      await log!.removeVehicle(first.id);
    });
    await waitFor(() => expect(log!.selectedVehicleId).toBe(second.id));
    await settle();

    expect(log!.fillUps.map((row) => row.vehicleId)).toEqual([second.id]);
    expect(mismatches).toEqual([]);
  });
});

describe('loads that overlap (#88)', () => {
  test('a load that finishes after a later one has been shown is not shown over it', async () => {
    let hold: Promise<void> | null = null;
    let release: () => void = () => {};
    /** A store whose read of one car's fill-ups waits, once asked to. */
    class SlowStore extends FuelTrackerStore {
      override async fillUps(vehicleId: string): Promise<FillUpSummary[]> {
        if (hold !== null && vehicleId === first.id) await hold;
        return super.fillUps(vehicleId);
      }
    }
    const store = new SlowStore({
      vehicles: new InMemoryRepository<VehicleRecord>(),
      fillUps: new InMemoryRepository<FillUpRecord>(),
      pendingFillUps: new InMemoryRepository<PendingFillUpRecord>(),
    });
    const first = await store.addVehicle({ name: 'Civic' });
    const second = await store.addVehicle({ name: 'Jazz' });
    await store.addFillUp(draft(10_000), first.id);
    let log: FuelLog | null = null;
    function Probe(): null {
      log = useFuelLog();
      return null;
    }
    render(
      <FuelLogProvider store={store} remote={null} uid={null}>
        <Probe />
      </FuelLogProvider>,
    );
    await waitFor(() => expect(log!.selectedVehicleId).toBe(first.id));

    // A reload starts, and is slow; then somebody picks the other car, which
    // loads at once.
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reloading: Promise<unknown> = Promise.resolve();
    await act(async () => {
      reloading = log!.addFillUp(draft(10_300), first.id);
    });
    await act(async () => {
      log!.selectVehicle(second.id);
    });
    await waitFor(() => expect(log!.selectedVehicleId).toBe(second.id));

    // The slow reload finishes last: what it read is older than what is shown.
    await act(async () => {
      release();
      await reloading;
    });
    await settle();

    expect(log!.selectedVehicleId).toBe(second.id);
    expect(log!.fillUps).toEqual([]);
  });
});
