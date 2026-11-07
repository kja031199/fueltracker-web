// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { InMemoryRepository } from '../data/repository';
import type { FillUpRecord, PendingFillUpRecord, VehicleRecord } from '../data/records';
import { InMemoryRemoteStore, type PullCursor, type RawSnapshot } from '../data/remote';
import { FuelTrackerStore } from '../data/store';
import { StubAuthProvider } from '../data/auth';
import { App } from './App';
import { saveHasOnboarded } from './onboarding';

/**
 * A sync that changes nothing re-renders no screen (#88).
 *
 * Sync status changes several times per sync. It used to live in the context
 * every screen reads, and the app shell read it too, so each step of every
 * sync re-rendered the whole app. Counted here at the dashboard, through the
 * real `App`.
 */

const counted = vi.hoisted(() => ({ dashboard: 0 }));
vi.mock('./DashboardScreen', async (original) => {
  const actual = await original<typeof import('./DashboardScreen')>();
  return {
    ...actual,
    DashboardScreen: (props: Parameters<typeof actual.DashboardScreen>[0]) => {
      counted.dashboard += 1;
      return actual.DashboardScreen(props);
    },
  };
});

beforeEach(() => localStorage.clear());
afterEach(cleanup);

/** An account whose first read waits until the test lets it through. */
class HeldRemote extends InMemoryRemoteStore {
  release: () => void = () => {};
  private readonly held = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  override async pull(since?: PullCursor | null): Promise<RawSnapshot> {
    await this.held;
    return super.pull(since);
  }
}

test('the dashboard is not re-rendered by a sync that brings nothing', async () => {
  saveHasOnboarded('u1');
  const store = new FuelTrackerStore({
    vehicles: new InMemoryRepository<VehicleRecord>(),
    fillUps: new InMemoryRepository<FillUpRecord>(),
    pendingFillUps: new InMemoryRepository<PendingFillUpRecord>(),
  });
  await store.addVehicle({ name: 'Civic' });
  const remote = new HeldRemote();
  const auth = new StubAuthProvider({
    status: 'signedIn',
    user: { uid: 'u1', email: 'a@example.com', displayName: 'A' },
  });
  render(<App store={store} auth={auth} remote={remote} initialTab="dashboard" />);
  // Showing the car, while the mount sync waits on the account.
  await screen.findByRole('navigation', { name: /sections/i });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  counted.dashboard = 0;

  await act(async () => {
    remote.release();
  });
  // The sync has run: it pushed this device's car.
  await waitFor(async () => {
    const before = remote.pullLog.length;
    const held = (await remote.pull()).vehicles;
    remote.pullLog.length = before;
    expect(held).toHaveLength(1);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  expect(counted.dashboard).toBe(0);
});
