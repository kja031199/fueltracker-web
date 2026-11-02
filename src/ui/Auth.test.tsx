// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InMemoryRepository } from '../data/repository';
import type { FillUpRecord, PendingFillUpRecord, VehicleRecord } from '../data/records';
import { FuelTrackerStore } from '../data/store';
import { StubAuthProvider } from '../data/auth';
import { InMemoryRemoteStore } from '../data/remote';
import { App } from './App';
import { describeSyncTime } from './SettingsScreen';

function makeStore(): FuelTrackerStore {
  return new FuelTrackerStore({
    vehicles: new InMemoryRepository<VehicleRecord>(),
    fillUps: new InMemoryRepository<FillUpRecord>(),
    pendingFillUps: new InMemoryRepository<PendingFillUpRecord>(),
  });
}

const USER = { uid: 'u1', email: 'driver@example.com', displayName: 'Driver' };

beforeEach(() => {
  localStorage.clear();
});

afterEach(cleanup);

describe('the sign-in gate', () => {
  test('a restoring session shows neither the app nor the sign-in screen', () => {
    // Firebase restores a persisted session asynchronously. Treating that
    // moment as "signed out" would flash this screen at an already-signed-in
    // reader on every single load, including offline where the restore
    // succeeds from IndexedDB.
    render(<App store={makeStore()} auth={new StubAuthProvider({ status: 'loading' })} />);
    expect(screen.getByText(/checking your account/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /continue with google/i })).not.toBeInTheDocument();
  });

  test('a signed-out reader is asked to sign in and sees no data', async () => {
    render(
      <App
        store={makeStore()}
        auth={new StubAuthProvider({ status: 'signedOut', error: null })}
      />,
    );
    expect(await screen.findByRole('button', { name: /continue with google/i })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: /sections/i })).not.toBeInTheDocument();
  });

  test('signing in opens the app', async () => {
    const user = userEvent.setup();
    const auth = new StubAuthProvider({ status: 'signedOut', error: null }, USER);
    render(<App store={makeStore()} auth={auth} />);

    await user.click(await screen.findByRole('button', { name: /continue with google/i }));

    // No vehicles yet, so the first-run welcome is what should appear — the
    // gate hands over to the normal flow rather than replacing it.
    expect(await screen.findByRole('heading', { name: /welcome/i })).toBeInTheDocument();
  });

  test('a failed sign-in says why and leaves the button usable', async () => {
    const user = userEvent.setup();
    const auth = new StubAuthProvider(
      { status: 'signedOut', error: null },
      USER,
      'Your browser blocked the sign-in window.',
    );
    render(<App store={makeStore()} auth={auth} />);

    await user.click(await screen.findByRole('button', { name: /continue with google/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/blocked the sign-in window/i);
    // Still clickable: a cancelled popup is the most common failure and must
    // not leave the only control dead.
    expect(screen.getByRole('button', { name: /continue with google/i })).toBeEnabled();
  });

  test('a build with no Firebase config explains itself instead of offering a dead button', async () => {
    render(
      <App
        store={makeStore()}
        auth={new StubAuthProvider({ status: 'signedOut', error: null })}
        configured={false}
      />,
    );
    expect(await screen.findByText(/no firebase configuration/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /continue with google/i })).not.toBeInTheDocument();
  });

  test('signing out from Settings returns to the gate', async () => {
    const user = userEvent.setup();
    const auth = new StubAuthProvider({ status: 'signedIn', user: USER }, USER);
    const store = makeStore();
    await store.addVehicle({ name: 'Civic' });

    render(<App store={store} auth={auth} initialTab="settings" />);

    expect(await screen.findByText(/driver@example\.com/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /sign out/i }));

    expect(await screen.findByRole('button', { name: /continue with google/i })).toBeInTheDocument();
  });
});

describe('the account section', () => {
  test('a build with no backend says nothing is syncing', async () => {
    const store = makeStore();
    await store.addVehicle({ name: 'Civic' });
    render(
      <App
        store={store}
        auth={new StubAuthProvider({ status: 'signedIn', user: USER }, USER)}
        initialTab="settings"
      />,
    );
    expect(await screen.findByText(/no backend configured/i)).toBeInTheDocument();
  });

  test('a sync on open pulls the account down and the screens show it', async () => {
    const store = makeStore();
    const remote = new InMemoryRemoteStore({
      vehicles: [
        {
          id: 'v-remote',
          updatedAt: 500,
          deletedAt: null,
          schemaVersion: 1,
          name: 'Account Car',
          make: 'Honda',
          model: 'Civic',
          year: 2019,
          createdAt: 500,
        },
      ],
      fillUps: [],
      pendingFillUps: [],
    });

    render(
      <App
        store={store}
        auth={new StubAuthProvider({ status: 'signedIn', user: USER }, USER)}
        remote={remote}
        initialTab="vehicles"
      />,
    );

    // Arrives through the sync on mount, not from local storage — the store
    // started empty.
    expect(await screen.findByText(/Account Car/)).toBeInTheDocument();
  });

  describe('the account id', () => {
    /**
     * The uid is the identifier `firestore.rules` allowlists (#27), and it was
     * nowhere in the app — so adding somebody meant the owner digging through
     * the Firebase console's Users table after the person had already been
     * refused. It is on their own Settings screen instead.
     *
     * It keeps working in exactly the case it is needed: the uid comes from
     * Auth, not Firestore, so a person who is signed in but allowlisted out
     * can still read their own id while every data read is being denied.
     */

    /**
     * Stubs `navigator.clipboard`.
     *
     * **Call this after `userEvent.setup()`, never before.** user-event
     * installs its own clipboard stub on setup, so a stub written first is
     * silently replaced and the spy records nothing — which reads exactly like
     * a button that does not work.
     */
    function clipboard(): ReturnType<typeof vi.fn> {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      return writeText;
    }

    async function openSettings(): Promise<void> {
      const store = makeStore();
      await store.addVehicle({ name: 'Civic' });
      render(
        <App
          store={store}
          auth={new StubAuthProvider({ status: 'signedIn', user: USER }, USER)}
          initialTab="settings"
        />,
      );
      await screen.findByRole('navigation', { name: /sections/i });
    }

    test('is shown, so it can be read off the screen', async () => {
      await openSettings();
      expect(screen.getByText(USER.uid)).toBeInTheDocument();
    });

    test('copies to the clipboard on request', async () => {
      const user = userEvent.setup();
      const writeText = clipboard();
      await openSettings();

      await user.click(screen.getByRole('button', { name: /copy account id/i }));

      expect(writeText).toHaveBeenCalledWith(USER.uid);
      expect(await screen.findByText(/copied/i)).toBeInTheDocument();
    });

    test('says to copy it by hand when the browser refuses the clipboard', async () => {
      // No clipboard at all: plain http, an old browser, a blocked permission.
      // The id is on screen either way, so the honest failure is to say so
      // rather than to leave a dead button.
      const user = userEvent.setup();
      Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
      await openSettings();

      await user.click(screen.getByRole('button', { name: /copy account id/i }));

      expect(await screen.findByText(/by hand/i)).toBeInTheDocument();
      expect(screen.getByText(USER.uid)).toBeInTheDocument();
    });

    test('survives a clipboard that rejects', async () => {
      const user = userEvent.setup();
      const writeText = vi.fn().mockRejectedValue(new Error('denied'));
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      await openSettings();

      await user.click(screen.getByRole('button', { name: /copy account id/i }));

      expect(await screen.findByText(/by hand/i)).toBeInTheDocument();
    });
  });

  test('a sync failure is reported without taking the app down', async () => {
    const store = makeStore();
    await store.addVehicle({ name: 'Civic' });
    const remote = new InMemoryRemoteStore();
    remote.failPull = true;

    render(
      <App
        store={store}
        auth={new StubAuthProvider({ status: 'signedIn', user: USER }, USER)}
        remote={remote}
        initialTab="settings"
      />,
    );

    // Being unreachable is the ordinary condition of an offline-first app, so
    // it is a status line and the local data keeps working.
    expect(await screen.findByRole('status')).toHaveTextContent(/could not reach your account/i);
    expect(screen.getByRole('navigation', { name: /sections/i })).toBeInTheDocument();
  });

  test('a row the account cannot address is reported, not left as a silent failure', async () => {
    // #26. This used to present as the ordinary "not uploaded yet", forever,
    // while every later fill-up quietly stopped reaching the account too.
    const fillUps = new InMemoryRepository<FillUpRecord>([
      {
        id: 'a/b',
        updatedAt: 900,
        deletedAt: null,
        schemaVersion: 1,
        vehicleId: 'v1',
        date: 1_700_000_000_000,
        odometer: 10_000,
        gallons: 10,
        pricePerGallon: 3.5,
        isFullTank: true,
        missedPreviousFillUp: false,
        fuelGrade: 'Regular',
        station: '',
        notes: '',
        latitude: null,
        longitude: null,
        receiptImageData: null,
      },
    ]);
    const store = new FuelTrackerStore({
      vehicles: new InMemoryRepository<VehicleRecord>(),
      fillUps,
      pendingFillUps: new InMemoryRepository<PendingFillUpRecord>(),
    });
    await store.addVehicle({ name: 'Civic' });

    render(
      <App
        store={store}
        auth={new StubAuthProvider({ status: 'signedIn', user: USER }, USER)}
        remote={new InMemoryRemoteStore()}
        initialTab="settings"
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(/could not be uploaded/i),
    );
  });

  test('a large receipt is reported as staying on the device', async () => {
    const store = makeStore();
    const added = await store.addVehicle({ name: 'Civic' });
    const { makeFuelEntryDraft } = await import('../domain/fuelEntryDraft');
    const draft = makeFuelEntryDraft({
      date: new Date(1_700_000_000_000),
      odometer: 10_000,
      gallons: 10,
      pricePerGallon: 3.5,
      receiptImageData: new Uint8Array(900 * 1024),
    });
    await store.addFillUp(draft!, added.id);

    const remote = new InMemoryRemoteStore();
    remote.receiptByteLimit = 700 * 1024;

    render(
      <App
        store={store}
        auth={new StubAuthProvider({ status: 'signedIn', user: USER }, USER)}
        remote={remote}
        initialTab="settings"
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(/too large to sync/i),
    );
  });
});

describe('describeSyncTime', () => {
  const now = new Date('2026-03-10T12:00:00Z').getTime();

  test('says so plainly when nothing has synced yet', () => {
    expect(describeSyncTime(null, now)).toBe('not yet');
  });

  test('reads as just now inside a minute', () => {
    expect(describeSyncTime(now - 5_000, now)).toBe('just now');
  });

  test('counts minutes, then hours', () => {
    expect(describeSyncTime(now - 3 * 60_000, now)).toBe('3 minutes ago');
    expect(describeSyncTime(now - 60_000, now)).toBe('1 minute ago');
    expect(describeSyncTime(now - 2 * 3_600_000, now)).toBe('2 hours ago');
    expect(describeSyncTime(now - 3_600_000, now)).toBe('1 hour ago');
  });

  test('falls back to a date once it stops being recent', () => {
    expect(describeSyncTime(now - 3 * 24 * 3_600_000, now)).toBe(
      new Date(now - 3 * 24 * 3_600_000).toLocaleDateString(),
    );
  });

  test('does not read a clock-skewed future timestamp as a negative age', () => {
    // A device whose clock is ahead would otherwise produce "-4 minutes ago".
    expect(describeSyncTime(now + 240_000, now)).toBe('just now');
  });
});
