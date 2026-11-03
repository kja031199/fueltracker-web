// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ReactNode } from 'react';
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { InMemoryRepository } from '../data/repository';
import type { FillUpRecord, PendingFillUpRecord, VehicleRecord } from '../data/records';
import { InMemoryRemoteStore } from '../data/remote';
import { FuelTrackerStore } from '../data/store';
import type { FuelEntryDraft } from '../domain/fuelEntryDraft';
import { makeFuelEntryDraft } from '../domain/fuelEntryDraft';
import { FuelLogProvider, useFuelLog, type FuelLog } from './fuelLog';
import { SAVE_SYNC_DELAY_MS } from './syncScheduler';

/**
 * The one place a write happens (#56).
 *
 * Every screen used to call the store itself and then an `onChanged` it had
 * been handed, so "a write is followed by a refresh and a sync" was true only
 * where somebody remembered. These pin it once, for every action, at the
 * context — which is the only thing a screen can now write through.
 */

afterEach(cleanup);

function makeStore(): FuelTrackerStore {
  return new FuelTrackerStore({
    vehicles: new InMemoryRepository<VehicleRecord>(),
    fillUps: new InMemoryRepository<FillUpRecord>(),
    pendingFillUps: new InMemoryRepository<PendingFillUpRecord>(),
  });
}

function draft(odometer: number): FuelEntryDraft {
  const made = makeFuelEntryDraft({
    date: new Date(2026, 0, 1),
    odometer,
    gallons: 10,
    pricePerGallon: 3.5,
  });
  if (made === null) throw new Error('fixture draft failed validation');
  return made;
}

interface Harness {
  readonly store: FuelTrackerStore;
  readonly remote: InMemoryRemoteStore;
  readonly log: () => FuelLog;
}

async function mount(store: FuelTrackerStore = makeStore()): Promise<Harness> {
  const remote = new InMemoryRemoteStore();
  const wrapper = ({ children }: { children: ReactNode }): ReactNode => (
    <FuelLogProvider store={store} remote={remote} uid="u1">
      {children}
    </FuelLogProvider>
  );
  const { result } = renderHook(() => useFuelLog(), { wrapper });
  await waitFor(() => expect(result.current.loading).toBe(false));
  // The mount sync, so later counts start from a settled remote.
  await waitFor(() => expect(remote.pullLog.length).toBeGreaterThan(0));
  await waitFor(() => expect(result.current.sync.syncing).toBe(false));
  return { store, remote, log: () => result.current };
}

/** The remote's copy of one row, by id, or undefined. Reads without counting as a sync. */
async function remoteRow(remote: InMemoryRemoteStore, id: string): Promise<Record<string, unknown> | undefined> {
  const before = remote.pullLog.length;
  const snapshot = await remote.pull();
  remote.pullLog.length = before;
  const rows = [...snapshot.vehicles, ...snapshot.fillUps] as Record<string, unknown>[];
  return rows.find((row) => row['id'] === id);
}

/** True once the remote holds the row **and** it is a tombstone — never vacuously. */
async function tombstoned(remote: InMemoryRemoteStore, id: string): Promise<boolean> {
  const row = await remoteRow(remote, id);
  return row !== undefined && typeof row['deletedAt'] === 'number';
}

const SYNC_WINDOW = { timeout: SAVE_SYNC_DELAY_MS + 3000 };

describe('every write reaches the account without anyone remembering to ask', () => {
  test('addVehicle', async () => {
    const { remote, log } = await mount();
    let id = '';
    await act(async () => {
      id = (await log().addVehicle({ name: 'Civic' })).id;
    });
    expect(log().vehicles.map((v) => v.id)).toContain(id); // refreshed
    await waitFor(async () => expect(await remoteRow(remote, id)).toBeDefined(), SYNC_WINDOW);
  });

  test('removeVehicle', async () => {
    const { store, remote, log } = await mount();
    const vehicle = await store.addVehicle({ name: 'Civic' });
    await act(async () => {
      await log().removeVehicle(vehicle.id);
    });
    expect(log().vehicles).toHaveLength(0);
    await waitFor(async () => expect(await tombstoned(remote, vehicle.id)).toBe(true), SYNC_WINDOW);
  });

  test('addFillUp', async () => {
    const { store, remote, log } = await mount();
    const vehicle = await store.addVehicle({ name: 'Civic' });
    let id = '';
    await act(async () => {
      id = (await log().addFillUp(draft(1000), vehicle.id)).id;
    });
    expect(log().fillUpCount).toBe(1);
    await waitFor(async () => expect(await remoteRow(remote, id)).toBeDefined(), SYNC_WINDOW);
  });

  test('updateFillUp', async () => {
    const { store, remote, log } = await mount();
    const vehicle = await store.addVehicle({ name: 'Civic' });
    const entry = await store.addFillUp(draft(1000), vehicle.id);
    await act(async () => {
      await log().updateFillUp(entry.id, draft(1234), vehicle.id);
    });
    await waitFor(
      async () => expect((await remoteRow(remote, entry.id))?.['odometer']).toBe(1234),
      SYNC_WINDOW,
    );
  });

  test('removeFillUp', async () => {
    const { store, remote, log } = await mount();
    const vehicle = await store.addVehicle({ name: 'Civic' });
    const entry = await store.addFillUp(draft(1000), vehicle.id);
    await act(async () => {
      await log().removeFillUp(entry.id);
    });
    expect(log().fillUpCount).toBe(0);
    await waitFor(async () => expect(await tombstoned(remote, entry.id)).toBe(true), SYNC_WINDOW);
  });

  test('importBackup', async () => {
    const source = makeStore();
    const vehicle = await source.addVehicle({ name: 'Imported' });
    const snapshot = await source.exportSnapshot();
    const { remote, log } = await mount();
    await act(async () => {
      const summary = await log().importBackup(snapshot);
      expect(summary.vehiclesWritten).toBe(1);
    });
    expect(log().vehicles.map((v) => v.id)).toContain(vehicle.id);
    await waitFor(async () => expect(await remoteRow(remote, vehicle.id)).toBeDefined(), SYNC_WINDOW);
  });
});

describe('when a write does not happen', () => {
  test('a write that fails is reported, and neither refreshes nor syncs', async () => {
    const { store, remote, log } = await mount();
    vi.spyOn(store, 'addVehicle').mockRejectedValue(new Error('disk full'));
    const vehicles = vi.spyOn(store, 'vehicles');
    const syncsBefore = remote.pullLog.length;

    await act(async () => {
      await expect(log().addVehicle({ name: 'Civic' })).rejects.toThrow('disk full');
    });
    await new Promise((resolve) => setTimeout(resolve, SAVE_SYNC_DELAY_MS + 500));

    expect(vehicles).not.toHaveBeenCalled();
    expect(remote.pullLog.length).toBe(syncsBefore);
  });

  test('opening a fill-up that has gone refreshes the list but syncs nothing', async () => {
    // Deleted on another device since the list was drawn: there is nothing
    // to send, only something to stop showing.
    const { store, remote, log } = await mount();
    const vehicles = vi.spyOn(store, 'vehicles');
    const syncsBefore = remote.pullLog.length;

    let found: unknown = 'not called';
    await act(async () => {
      found = await log().loadFillUp('no-such-id');
    });
    await new Promise((resolve) => setTimeout(resolve, SAVE_SYNC_DELAY_MS + 500));

    expect(found).toBeUndefined();
    expect(vehicles).toHaveBeenCalled();
    expect(remote.pullLog.length).toBe(syncsBefore);
  });

  test('opening a fill-up that exists returns it whole, and writes nothing', async () => {
    const { store, log } = await mount();
    const vehicle = await store.addVehicle({ name: 'Civic' });
    const entry = await store.addFillUp(draft(1000), vehicle.id);
    const write = vi.spyOn(store, 'updateFillUp');
    let found: FillUpRecord | undefined;
    await act(async () => {
      found = await log().loadFillUp(entry.id);
    });
    expect(found?.id).toBe(entry.id);
    expect(write).not.toHaveBeenCalled();
  });
});

describe('outside the provider', () => {
  test('says what is wrong instead of failing somewhere downstream', () => {
    function Orphan(): ReactNode {
      useFuelLog();
      return null;
    }
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Orphan />)).toThrow(/FuelLogProvider/);
    error.mockRestore();
    expect(screen.queryByRole('main')).toBeNull();
  });
});
