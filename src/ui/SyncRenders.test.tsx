import { beforeEach, expect, test, vi } from 'vitest';
import { makeStore, saveHasOnboarded } from '../test/fixtures';
import { act, render, screen, waitFor } from '@testing-library/react';
import { type PullCursor, type RawSnapshot } from '../data/remote';
import { StubAuthProvider } from '../data/auth';
import { App } from './App';
import { InMemoryRemoteStore } from '../data/testing/inMemoryRemote';

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
    DashboardScreen: () => {
      counted.dashboard += 1;
      return actual.DashboardScreen();
    },
  };
});

beforeEach(() => localStorage.clear());

/** An account whose first read waits until the test lets it through. */
class HeldRemote extends InMemoryRemoteStore {
  release: () => void = () => {};
  private readonly held = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  /** Reads asked for, counted as they start — before the hold. */
  started = 0;

  override async pull(since?: PullCursor | null): Promise<RawSnapshot> {
    this.started += 1;
    await this.held;
    return super.pull(since);
  }
}

test('the dashboard is not re-rendered by a sync that brings nothing', async () => {
  saveHasOnboarded('u1');
  const store = makeStore();
  await store.addVehicle({ name: 'Civic' });
  const remote = new HeldRemote();
  const auth = new StubAuthProvider({
    status: 'signedIn',
    user: { uid: 'u1', email: 'a@example.com', displayName: 'A' },
  });
  render(<App store={store} auth={auth} remote={remote} initialTab="dashboard" />);
  // Showing the car, while the mount sync waits on the account: its read has
  // started, and is held (#97: waited for, not slept past).
  await screen.findByRole('navigation', { name: /sections/i });
  await waitFor(() => expect(remote.started).toBeGreaterThan(0));
  await act(async () => {});
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
  // The sync has finished: its last step records when it last worked.
  await waitFor(() => expect(localStorage.getItem('fueltracker.lastSyncedAt.u.u1')).not.toBeNull());
  await act(async () => {});

  expect(counted.dashboard).toBe(0);
});
