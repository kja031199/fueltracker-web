// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InMemoryRepository } from '../data/repository';
import type { FillUpRecord, PendingFillUpRecord, VehicleRecord } from '../data/records';
import { FuelTrackerStore } from '../data/store';
import { StubAuthProvider } from '../data/auth';
import { ACTIVITY_STORAGE_KEY, loadIdleTimeoutSetting } from './idleTimeout';
import { App } from './App';

/**
 * The idle timeout as a reader meets it.
 *
 * The rule is covered in `domain/idleTimeout.test.ts` and the plumbing in
 * `idleTimeout.test.tsx`. This file is about the two things only the whole app
 * can answer: that the setting is off until somebody turns it on, and that the
 * sign-in screen then *says why* the session ended rather than looking like a
 * dropped session.
 *
 * The honest-copy assertions are not decoration. This feature protects less
 * than its name suggests — the fuel log stays on the device and stays readable
 * in DevTools — and a lock that implies more safety than it delivers is worse
 * than none. If the copy that admits that is ever deleted, these fail.
 */

const USER = { uid: 'u1', email: 'driver@example.com', displayName: 'Driver' };

async function storeWithAVehicle(): Promise<FuelTrackerStore> {
  const store = new FuelTrackerStore({
    vehicles: new InMemoryRepository<VehicleRecord>(),
    fillUps: new InMemoryRepository<FillUpRecord>(),
    pendingFillUps: new InMemoryRepository<PendingFillUpRecord>(),
  });
  await store.addVehicle({ name: 'Civic' });
  return store;
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('fueltracker.hasOnboarded', 'true');
});

afterEach(cleanup);

describe('the security setting', () => {
  test('is off until somebody turns it on', async () => {
    render(<App store={await storeWithAVehicle()} initialTab="settings" />);
    const toggle = await screen.findByRole('checkbox', { name: /sign out after/i });
    expect(toggle).not.toBeChecked();
  });

  test('says what it does not protect, next to the switch', async () => {
    render(<App store={await storeWithAVehicle()} initialTab="settings" />);
    await screen.findByRole('checkbox', { name: /sign out after/i });
    // Both limits the owner accepted when choosing this shape.
    expect(screen.getByText(/stays on this device/i)).toBeInTheDocument();
    expect(screen.getByText(/needs a connection/i)).toBeInTheDocument();
  });

  test('turning it on is remembered', async () => {
    const user = userEvent.setup();
    const store = await storeWithAVehicle();
    const view = render(<App store={store} initialTab="settings" />);

    await user.click(await screen.findByRole('checkbox', { name: /sign out after/i }));
    expect(loadIdleTimeoutSetting().enabled).toBe(true);

    view.unmount();
    render(<App store={store} initialTab="settings" />);
    expect(await screen.findByRole('checkbox', { name: /sign out after/i })).toBeChecked();
  });

  test('the period can be changed, and is remembered', async () => {
    const user = userEvent.setup();
    render(<App store={await storeWithAVehicle()} initialTab="settings" />);

    await user.click(await screen.findByRole('checkbox', { name: /sign out after/i }));
    await user.selectOptions(screen.getByRole('combobox', { name: /inactive for/i }), '5');

    expect(loadIdleTimeoutSetting()).toEqual({ enabled: true, minutes: 5 });
  });
});

describe('a session that went idle', () => {
  beforeEach(() => {
    localStorage.setItem('fueltracker.idleTimeout', JSON.stringify({ enabled: true, minutes: 30 }));
  });

  test('is over by the time the page is open again', async () => {
    // The whole point: a tab left open on an unattended laptop. Opening it
    // must not show the fuel log, and a reload must not be a way back in.
    localStorage.setItem(ACTIVITY_STORAGE_KEY, String(Date.now() - 2 * 60 * 60 * 1000));
    const auth = new StubAuthProvider({ status: 'signedIn', user: USER }, USER);

    render(<App store={await storeWithAVehicle()} auth={auth} initialTab="settings" />);

    expect(
      await screen.findByRole('button', { name: /continue with google/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: /sections/i })).not.toBeInTheDocument();
  });

  test('says why, and does not pretend the data went with it', async () => {
    localStorage.setItem(ACTIVITY_STORAGE_KEY, String(Date.now() - 2 * 60 * 60 * 1000));
    const auth = new StubAuthProvider({ status: 'signedIn', user: USER }, USER);

    render(<App store={await storeWithAVehicle()} auth={auth} />);

    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent(/inactiv/i);
    // Saying "signed out" and leaving it there would imply the log was
    // protected. It is still in this browser, and the honest sentence says so.
    expect(notice).toHaveTextContent(/still/i);
  });

  test('stays open when nobody asked for a timeout', async () => {
    localStorage.setItem('fueltracker.idleTimeout', JSON.stringify({ enabled: false, minutes: 30 }));
    localStorage.setItem(ACTIVITY_STORAGE_KEY, String(Date.now() - 400 * 24 * 60 * 60 * 1000));
    const auth = new StubAuthProvider({ status: 'signedIn', user: USER }, USER);

    render(<App store={await storeWithAVehicle()} auth={auth} />);

    expect(await screen.findByRole('navigation', { name: /sections/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /continue with google/i })).not.toBeInTheDocument();
  });

  test('ends while the page is sitting open, not only across a reload', async () => {
    // Two things to get right at once. Fake timers go in *before* the render,
    // or the interval the hook arms is the real one and advancing does
    // nothing. And only the clock the hook uses is faked: Testing Library
    // detects **Jest's** fake timers, not vitest's, so under a blanket
    // `useFakeTimers()` its `findBy*`/`waitFor` poll with a faked `setTimeout`
    // that never fires, and the test hangs to its own time limit.
    const store = await storeWithAVehicle();
    const auth = new StubAuthProvider({ status: 'signedIn', user: USER }, USER);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    try {
      render(<App store={store} auth={auth} />);
      await screen.findByRole('navigation', { name: /sections/i });

      act(() => {
        vi.advanceTimersByTime(31 * 60 * 1000);
      });

      await waitFor(() => {
        expect(auth.state().status).toBe('signedOut');
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
