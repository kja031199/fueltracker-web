// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { makeStore } from '../test/fixtures';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { FuelTrackerStore } from '../data/store';
import { StubAuthProvider } from '../data/auth';
import { ACTIVITY_STORAGE_KEY } from './idleTimeout';
import { ADMIN_IDLE_MINUTES } from './adminSettings';
import { DEFAULT_IDLE_MINUTES, idleMinutesFromConfig } from '../domain/idleTimeout';
import { App } from './App';
import { saveHasOnboarded } from './onboarding';

/**
 * The idle timeout as a reader meets it.
 *
 * Since #70 it is not a choice: one period, set by the administrator
 * (`VITE_IDLE_TIMEOUT_MINUTES`), applies to everyone, always. This file pins
 * the parts only the whole app can answer — Settings states the period and
 * offers no way to change it, an old per-browser choice cannot switch it off,
 * and the sign-in screen then *says why* the session ended.
 *
 * The honest-copy assertions are not decoration. This protects less than its
 * name suggests — the fuel log stays on the device and stays readable in
 * DevTools — and a lock that implies more safety than it delivers is worse
 * than none. If the copy that admits that is ever deleted, these fail.
 */

const USER = { uid: 'u1', email: 'driver@example.com', displayName: 'Driver' };

async function storeWithAVehicle(): Promise<FuelTrackerStore> {
  const store = makeStore();
  await store.addVehicle({ name: 'Civic' });
  return store;
}

beforeEach(() => {
  localStorage.clear();
  saveHasOnboarded(USER.uid);
});

afterEach(cleanup);

describe('Settings', () => {
  test('states the period, and offers no way to change it or turn it off', async () => {
    render(<App store={await storeWithAVehicle()} initialTab="settings" idleMinutes={45} />);
    await screen.findByRole('heading', { name: /security/i });
    expect(screen.getByText(/signed out after 45 minutes of inactivity/i)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /sign out/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /inactive/i })).not.toBeInTheDocument();
  });

  test('says what it does not protect', async () => {
    render(<App store={await storeWithAVehicle()} initialTab="settings" />);
    await screen.findByRole('heading', { name: /security/i });
    expect(screen.getByText(/stays on this device/i)).toBeInTheDocument();
    expect(screen.getByText(/needs a connection/i)).toBeInTheDocument();
  });
});

describe('the period', () => {
  test("is the administrator's, read once at build time, with a 30-minute floor for a bad value", () => {
    // In tests the Variable is normally unset, so this is the default — but
    // it is the wiring that is pinned, not the number.
    expect(ADMIN_IDLE_MINUTES).toBe(idleMinutesFromConfig(import.meta.env.VITE_IDLE_TIMEOUT_MINUTES));
    expect(idleMinutesFromConfig(undefined)).toBe(DEFAULT_IDLE_MINUTES);
  });

  test('an old per-browser choice is deleted when the app starts', async () => {
    localStorage.setItem('fueltracker.idleTimeout', JSON.stringify({ enabled: false, minutes: 30 }));
    render(<App store={await storeWithAVehicle()} />);
    await screen.findByRole('navigation', { name: /sections/i });
    expect(localStorage.getItem('fueltracker.idleTimeout')).toBeNull();
  });
});

describe('a session that went idle', () => {
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

    render(<App store={await storeWithAVehicle()} auth={auth} idleMinutes={45} />);

    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent(/45 minutes of inactivity/i);
    // Saying "signed out" and leaving it there would imply the log was
    // protected. It is still in this browser, and the honest sentence says so.
    expect(notice).toHaveTextContent(/still/i);
    // Nobody chose this any more, so the notice must not say they did.
    expect(notice).not.toHaveTextContent(/you turned on|your setting/i);
  });

  test('ends even if this browser once switched the timeout off', async () => {
    // The point of #70: a choice made here before cannot opt out.
    localStorage.setItem('fueltracker.idleTimeout', JSON.stringify({ enabled: false, minutes: 30 }));
    localStorage.setItem(ACTIVITY_STORAGE_KEY, String(Date.now() - 2 * 60 * 60 * 1000));
    const auth = new StubAuthProvider({ status: 'signedIn', user: USER }, USER);

    render(<App store={await storeWithAVehicle()} auth={auth} />);

    expect(await screen.findByRole('button', { name: /continue with google/i })).toBeInTheDocument();
  });

  test('a stored longer period cannot stretch the administrator\'s', async () => {
    localStorage.setItem('fueltracker.idleTimeout', JSON.stringify({ enabled: true, minutes: 1440 }));
    localStorage.setItem(ACTIVITY_STORAGE_KEY, String(Date.now() - 10 * 60 * 1000));
    const auth = new StubAuthProvider({ status: 'signedIn', user: USER }, USER);

    render(<App store={await storeWithAVehicle()} auth={auth} idleMinutes={5} />);

    expect(await screen.findByRole('button', { name: /continue with google/i })).toBeInTheDocument();
  });

  test('a recent session stays open', async () => {
    localStorage.setItem(ACTIVITY_STORAGE_KEY, String(Date.now() - 60 * 1000));
    const auth = new StubAuthProvider({ status: 'signedIn', user: USER }, USER);

    render(<App store={await storeWithAVehicle()} auth={auth} />);

    expect(await screen.findByRole('navigation', { name: /sections/i })).toBeInTheDocument();
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
