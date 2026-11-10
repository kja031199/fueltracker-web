import { describe, expect, test, vi } from 'vitest';
import { draft, makeStore } from '../test/fixtures';
import type { ReactNode } from 'react';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { FillUpRecord } from '../data/records';
import { InMemoryRemoteStore } from '../data/testing/inMemoryRemote';
import { InMemorySharingWorld } from '../data/testing/inMemorySharing';
import { InMemoryShareLedger } from '../data/testing/inMemoryShareLedger';
import { FuelTrackerStore } from '../data/store';
import { FuelLogProvider, useBackupStatus, useFuelLog, useSyncStatus, type BackupStatus, type FuelLog } from './fuelLog';
import { toJsonBackup } from '../data/backupFormat';
import { loadBackupState } from './backupNudge';
import { manualTimers, type ManualTimers } from '../test/manualTimers';
import type { SharingSync } from '../data/shareSync';
import { LEDGER_UNREADABLE } from './syncMessages';
import { InMemorySyncState } from '../data/syncState';

/**
 * The one place a write happens (#56).
 *
 * Every screen used to call the store itself and then an `onChanged` it had
 * been handed, so "a write is followed by a refresh and a sync" was true only
 * where somebody remembered. These pin it once, for every action, at the
 * context — which is the only thing a screen can now write through.
 */

interface Harness {
  readonly store: FuelTrackerStore;
  readonly remote: InMemoryRemoteStore;
  readonly log: () => FuelLog;
  /** The backup reminder, and the log object itself rather than a copy of it. */
  readonly seen: () => { readonly backup: BackupStatus; readonly raw: FuelLog };
  /** The sync scheduler's timers, held by the test (#97). */
  readonly timers: ManualTimers;
  /** A write has scheduled its sync: run it now, rather than wait 1.5 seconds for it. */
  readonly synced: () => Promise<void>;
}

async function mount(store: FuelTrackerStore = makeStore()): Promise<Harness> {
  const remote = new InMemoryRemoteStore();
  const timers = manualTimers();
  const wrapper = ({ children }: { children: ReactNode }): ReactNode => (
    <FuelLogProvider store={store} remote={remote} uid="u1" syncTimers={timers}>
      {children}
    </FuelLogProvider>
  );
  const { result } = renderHook(
    () => ({ ...useFuelLog(), sync: useSyncStatus(), backup: useBackupStatus(), raw: useFuelLog() }),
    { wrapper },
  );
  await waitFor(() => expect(result.current.loading).toBe(false));
  // The mount sync, so later counts start from a settled remote.
  await waitFor(() => expect(remote.pullLog.length).toBeGreaterThan(0));
  await waitFor(() => expect(result.current.sync.syncing).toBe(false));
  const synced = async (): Promise<void> => {
    expect(timers.pending(), 'a write should have scheduled a sync').toBeGreaterThan(0);
    await act(async () => {
      timers.fire();
    });
    await waitFor(() => expect(result.current.sync.syncing).toBe(false));
  };
  return { store, remote, log: () => result.current, seen: () => result.current, timers, synced };
}

/** The remote's copy of one row, by id, or undefined. Reads without counting as a sync. */
async function remoteRow(remote: InMemoryRemoteStore, id: string): Promise<Record<string, unknown> | undefined> {
  const before = remote.pullLog.length;
  const snapshot = await remote.pull();
  remote.pullLog.length = before;
  const rows = [...snapshot.vehicles, ...snapshot.fillUps, ...snapshot.pendingFillUps] as Record<string, unknown>[];
  return rows.find((row) => row['id'] === id);
}

/** True once the remote holds the row **and** it is a tombstone — never vacuously. */
async function tombstoned(remote: InMemoryRemoteStore, id: string): Promise<boolean> {
  const row = await remoteRow(remote, id);
  return row !== undefined && typeof row['deletedAt'] === 'number';
}

describe('every write reaches the account without anyone remembering to ask', () => {
  test('addVehicle', async () => {
    const { remote, log, synced } = await mount();
    let id = '';
    await act(async () => {
      id = (await log().addVehicle({ name: 'Civic' })).id;
    });
    expect(log().vehicles.map((v) => v.id)).toContain(id); // refreshed
    await synced();
    await waitFor(async () => expect(await remoteRow(remote, id)).toBeDefined());
  });

  test('removeVehicle', async () => {
    const { store, remote, log, synced } = await mount();
    const vehicle = await store.addVehicle({ name: 'Civic' });
    await act(async () => {
      await log().removeVehicle(vehicle.id);
    });
    expect(log().vehicles).toHaveLength(0);
    await synced();
    await waitFor(async () => expect(await tombstoned(remote, vehicle.id)).toBe(true));
  });

  test('addFillUp', async () => {
    const { store, remote, log, synced } = await mount();
    const vehicle = await store.addVehicle({ name: 'Civic' });
    let id = '';
    await act(async () => {
      id = (await log().addFillUp(draft(1000), vehicle.id)).id;
    });
    expect(log().fillUpCount).toBe(1);
    await synced();
    await waitFor(async () => expect(await remoteRow(remote, id)).toBeDefined());
  });

  test('updateFillUp', async () => {
    const { store, remote, log, synced } = await mount();
    const vehicle = await store.addVehicle({ name: 'Civic' });
    const entry = await store.addFillUp(draft(1000), vehicle.id);
    await act(async () => {
      await log().updateFillUp(entry.id, draft(1234));
    });
    await synced();
    await waitFor(
      async () => expect((await remoteRow(remote, entry.id))?.['odometer']).toBe(1234));
  });

  test('removeFillUp', async () => {
    const { store, remote, log, synced } = await mount();
    const vehicle = await store.addVehicle({ name: 'Civic' });
    const entry = await store.addFillUp(draft(1000), vehicle.id);
    await act(async () => {
      await log().removeFillUp(entry.id);
    });
    expect(log().fillUpCount).toBe(0);
    await synced();
    await waitFor(async () => expect(await tombstoned(remote, entry.id)).toBe(true));
  });

  test('importBackup', async () => {
    const source = makeStore();
    const vehicle = await source.addVehicle({ name: 'Imported' });
    const snapshot = await source.exportSnapshot();
    const { remote, log, synced } = await mount();
    await act(async () => {
      const summary = await log().importBackup(snapshot);
      expect(summary.vehiclesWritten).toBe(1);
    });
    expect(log().vehicles.map((v) => v.id)).toContain(vehicle.id);
    await synced();
    await waitFor(async () => expect(await remoteRow(remote, vehicle.id)).toBeDefined());
  });

  test('importFile', async () => {
    const source = makeStore();
    const vehicle = await source.addVehicle({ name: 'Imported' });
    const file = new File([toJsonBackup(await source.exportSnapshot())], 'backup.json');
    const { remote, log, synced } = await mount();
    await act(async () => {
      const result = await log().importFile(file);
      expect(result.summary?.vehiclesWritten).toBe(1);
      expect(result.problems).toEqual([]);
    });
    expect(log().vehicles.map((v) => v.id)).toContain(vehicle.id);
    await synced();
    await waitFor(async () => expect(await remoteRow(remote, vehicle.id)).toBeDefined());
  });

  test('importFile reports a row the file could not be read for, and still imports the rest', async () => {
    const { store, log } = await mount();
    const vehicle = await store.addVehicle({ name: 'Civic' });
    const csv =
      'id,vehicle_id,date_iso,odometer_miles,gallons,price_per_gallon\n' +
      `f1,${vehicle.id},2025-01-15T00:00:00Z,10000,10,3.5\n` +
      `f2,${vehicle.id},not a date,10400,10,3.5\n`;
    await act(async () => {
      const result = await log().importFile(new File([csv], 'export.csv'));
      expect(result.summary?.fillUpsWritten).toBe(1);
      expect(result.problems).toEqual(['row 3 has an unreadable date']);
    });
  });

  // Fill-ups sent by link (#3).
  function sent(vehicleId: string, id = 'sub-1') {
    return { id, vehicleId, submitterName: 'Sam', submittedAt: 1, draft: draft(2000) };
  }

  test('receiveSubmission', async () => {
    const { store, remote, log, synced } = await mount();
    const vehicle = await store.addVehicle({ name: 'Civic' });
    await act(async () => {
      expect(await log().receiveSubmission(sent(vehicle.id))).toBe('queued');
    });
    expect(log().pending.map((row) => row.id)).toEqual(['sub-1']); // refreshed
    await synced();
    await waitFor(async () => expect(await remoteRow(remote, 'sub-1')).toBeDefined());
  });

  test('approveSubmission', async () => {
    const { store, remote, log, synced } = await mount();
    const vehicle = await store.addVehicle({ name: 'Civic' });
    await store.receiveSubmission(sent(vehicle.id));
    let id = '';
    await act(async () => {
      id = (await log().approveSubmission('sub-1'))?.id ?? '';
    });
    expect(log().pending).toHaveLength(0);
    expect(log().fillUpCount).toBe(1);
    await synced();
    await waitFor(async () => expect(await remoteRow(remote, id)).toBeDefined());
    await waitFor(async () => expect(await tombstoned(remote, 'sub-1')).toBe(true));
  });

  test('rejectSubmission', async () => {
    const { store, remote, log, synced } = await mount();
    const vehicle = await store.addVehicle({ name: 'Civic' });
    await store.receiveSubmission(sent(vehicle.id));
    await act(async () => {
      await log().rejectSubmission('sub-1');
    });
    expect(log().pending).toHaveLength(0);
    await synced();
    await waitFor(async () => expect(await tombstoned(remote, 'sub-1')).toBe(true));
  });

  test('a car this device holds as shared with it is not yours to receive for, even before the lists catch up', async () => {
    const store = makeStore();
    const vehicle = await store.addVehicle({ name: 'Civic' });
    const world = new InMemorySharingWorld();
    const shareRemote = world.sharingFor({ uid: 'u1', name: 'Me', email: 'me@example.com', emailVerified: true });
    // Offline for the membership list: only the device's ledger knows.
    shareRemote.memberships = () => Promise.reject(new Error('offline'));
    const ledger = new InMemoryShareLedger();
    const sharing: SharingSync = {
      remote: shareRemote,
      stateFor: () => new InMemorySyncState(),
      forgetState: async () => {},
      ledger,
    };
    const remote = new InMemoryRemoteStore();
    const wrapper = ({ children }: { children: ReactNode }): ReactNode => (
      <FuelLogProvider store={store} remote={remote} uid="u1" sharing={sharing}>
        {children}
      </FuelLogProvider>
    );
    const { result } = renderHook(() => ({ ...useFuelLog(), sync: useSyncStatus() }), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(remote.pullLog.length).toBeGreaterThan(0));
    await waitFor(() => expect(result.current.sync.syncing).toBe(false));
    expect(result.current.sharing.membershipFor(vehicle.id)).toBeUndefined();

    // A sync has just recorded the share; the lists in state have not caught up.
    await ledger.save([{ ownerUid: 'owner', vehicleId: vehicle.id, ownerName: 'Kyle', vehicleName: 'Civic' }]);
    let outcome = '';
    await act(async () => {
      outcome = await result.current.receiveSubmission(sent(vehicle.id));
    });
    expect(outcome).toBe('not-yours');
    expect(await store.pendingFillUps()).toHaveLength(0);
  });
});

describe('a device that cannot read its share ledger (#77)', () => {
  test('says so, as a pause to retry — not as the account refusing it', async () => {
    const store = makeStore();
    const world = new InMemorySharingWorld();
    const ledger = new InMemoryShareLedger();
    ledger.load = () => Promise.reject(new Error('storage blocked'));
    const sharing: SharingSync = {
      remote: world.sharingFor({ uid: 'u1', name: 'Me', email: 'me@example.com', emailVerified: true }),
      stateFor: () => new InMemorySyncState(),
      forgetState: async () => {},
      ledger,
    };
    const remote = new InMemoryRemoteStore();
    const wrapper = ({ children }: { children: ReactNode }): ReactNode => (
      <FuelLogProvider store={store} remote={remote} uid="u1" sharing={sharing}>
        {children}
      </FuelLogProvider>
    );
    const { result } = renderHook(() => ({ ...useFuelLog(), sync: useSyncStatus() }), { wrapper });
    await waitFor(() => expect(result.current.sync.message).toBe(LEDGER_UNREADABLE));
    expect(result.current.sync.refused).toBe(false);
    // Nothing reached the account.
    expect(remote.pullLog).toHaveLength(0);
  });
});

describe('when a write does not happen', () => {
  test('a write that fails is reported, and neither refreshes nor syncs', async () => {
    const { store, remote, log, timers } = await mount();
    vi.spyOn(store, 'addVehicle').mockRejectedValue(new Error('disk full'));
    const vehicles = vi.spyOn(store, 'vehicles');
    const syncsBefore = remote.pullLog.length;

    await act(async () => {
      await expect(log().addVehicle({ name: 'Civic' })).rejects.toThrow('disk full');
    });
    // Nothing was scheduled: counted, not slept on (#97).
    expect(timers.pending()).toBe(0);

    expect(vehicles).not.toHaveBeenCalled();
    expect(remote.pullLog.length).toBe(syncsBefore);
  });

  test('a file that cannot be read imports nothing, says why, and neither refreshes nor syncs', async () => {
    const { store, remote, log, timers } = await mount();
    const importing = vi.spyOn(store, 'importBackup');
    const vehicles = vi.spyOn(store, 'vehicles');
    const syncsBefore = remote.pullLog.length;

    let result: Awaited<ReturnType<FuelLog['importFile']>> | undefined;
    await act(async () => {
      result = await log().importFile(new File(['{ not json'], 'backup.json'));
    });
    // Nothing was scheduled: counted, not slept on (#97).
    expect(timers.pending()).toBe(0);

    expect(result).toEqual({ summary: null, problems: ['That file is not valid JSON.'] });
    expect(importing).not.toHaveBeenCalled();
    expect(vehicles).not.toHaveBeenCalled();
    expect(remote.pullLog.length).toBe(syncsBefore);
  });

  test('opening a fill-up that has gone refreshes the list but syncs nothing', async () => {
    // Deleted on another device since the list was drawn: there is nothing
    // to send, only something to stop showing.
    const { store, remote, log, timers } = await mount();
    const vehicles = vi.spyOn(store, 'vehicles');
    const syncsBefore = remote.pullLog.length;

    let found: unknown = 'not called';
    await act(async () => {
      found = await log().loadFillUp('no-such-id');
    });
    // Nothing was scheduled: counted, not slept on (#97).
    expect(timers.pending()).toBe(0);

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

describe('a backup is recorded by the log, whoever asked for it (#93)', () => {
  // The no-access screen downloaded a backup and recorded nothing, because the
  // recording was left to each caller. It is the log's job now.
  function stubDownloads(): () => void {
    const create = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    const revoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
    Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:x'), writable: true, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), writable: true, configurable: true });
    return () => {
      if (create) Object.defineProperty(URL, 'createObjectURL', create);
      if (revoke) Object.defineProperty(URL, 'revokeObjectURL', revoke);
    };
  }

  async function withOneLiveAndOneDeleted(): Promise<FuelTrackerStore> {
    const store = makeStore();
    const vehicle = await store.addVehicle({ name: 'Civic' });
    await store.addFillUp(draft(1000), vehicle.id);
    const gone = await store.addFillUp(draft(1300), vehicle.id);
    await store.removeFillUp(gone.id);
    return store;
  }

  test('saveBackup records it for the reminder, with the live fill-ups it held', async () => {
    const restore = stubDownloads();
    try {
      localStorage.clear();
      const { log, seen } = await mount(await withOneLiveAndOneDeleted());
      expect(seen().backup.lastBackupAt).toBeNull();

      await act(async () => {
        expect(await log().saveBackup()).toEqual({ vehicles: 1, fillUps: 1 });
      });

      expect(seen().backup.lastBackupAt).not.toBeNull();
      expect(loadBackupState('u1')).toMatchObject({ fillUpsAtLastExport: 1 });
    } finally {
      restore();
    }
  });

  test('a CSV export is not a backup, so it records nothing', async () => {
    const restore = stubDownloads();
    try {
      localStorage.clear();
      const { log, seen } = await mount(await withOneLiveAndOneDeleted());

      await act(async () => {
        expect(await log().exportCsv()).toBe(1); // the live one only
      });

      expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
      expect(seen().backup.lastBackupAt).toBeNull();
      expect(loadBackupState('u1').lastExportAt).toBeNull();
    } finally {
      restore();
    }
  });

  test('recording one changes the reminder, not the log every screen reads (#88)', async () => {
    const restore = stubDownloads();
    try {
      localStorage.clear();
      const { log, seen } = await mount();
      const before = seen().raw;
      await act(async () => {
        await log().saveBackup();
      });
      expect(seen().backup.lastBackupAt).not.toBeNull();
      expect(seen().raw).toBe(before);
    } finally {
      restore();
    }
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
