import { beforeEach, describe, expect, test, vi } from 'vitest';
import { makeStore, saveHasOnboarded } from '../test/fixtures';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StubAuthProvider } from '../data/auth';
import type { PushSummary, RawSnapshot, RemoteStore } from '../data/remote';
import { makeFuelEntryDraft } from '../domain/fuelEntryDraft';
import { App } from './App';
import { loadBackupState } from './backupNudge';

/**
 * What somebody sees when they are signed in but not on the allowlist.
 *
 * Issue #41. Auth succeeds, so the app used to open: no vehicles and no
 * `hasOnboarded` flag meant `shouldOnboard` showed them **"Welcome to
 * FuelTracker"**, and they could add a vehicle and log fill-ups while every
 * read and write to the account was refused. The onboarding copy promises
 * their log "is kept in your Google account" and "survives clearing your
 * browser data"; for them both sentences are false.
 *
 * The one thing they need is the account id to send to whoever runs the
 * deployment, and that was the one thing the app never said.
 */

const USER = { uid: 'guest-uid-1234567890123456', email: 'guest@example.com', displayName: 'Guest' };

/** Refuses the way Firestore does: a coded error, not a network failure. */
function refusing(): RemoteStore {
  return {
    async pull(): Promise<RawSnapshot> {
      const error = new Error('Missing or insufficient permissions.');
      (error as unknown as Record<string, unknown>)['code'] = 'permission-denied';
      throw error;
    },
    async push(): Promise<PushSummary> {
      return { written: 0, receiptsOmitted: 0 };
    },
  };
}

/** Refuses until `allow()` is called, so being added can be exercised. */
function refusingUntilAllowed(): RemoteStore & { allow: () => void } {
  let allowed = false;
  return {
    allow(): void {
      allowed = true;
    },
    async pull(): Promise<RawSnapshot> {
      if (allowed) return { vehicles: [], fillUps: [], pendingFillUps: [] };
      const error = new Error('Missing or insufficient permissions.');
      (error as unknown as Record<string, unknown>)['code'] = 'permission-denied';
      throw error;
    },
    async push(): Promise<PushSummary> {
      return { written: 0, receiptsOmitted: 0 };
    },
  };
}

function signedIn(): StubAuthProvider {
  return new StubAuthProvider({ status: 'signedIn', user: USER }, USER);
}

beforeEach(() => {
  localStorage.clear();
});

describe('a signed-in account that is not on the allowlist', () => {
  test('is told so, instead of being welcomed', async () => {
    render(<App store={makeStore()} auth={signedIn()} remote={refusing()} />);

    expect(await screen.findByRole('heading', { name: /does not have access/i })).toBeInTheDocument();
    // The two things it must not be: the first-run flow, or the app proper.
    expect(screen.queryByRole('heading', { name: /welcome/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: /sections/i })).not.toBeInTheDocument();
  });

  test('is shown the account id, which is the thing it has to send', async () => {
    render(<App store={makeStore()} auth={signedIn()} remote={refusing()} />);
    await screen.findByRole('heading', { name: /does not have access/i });

    expect(screen.getByText(USER.uid)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /copy account id/i })).toBeInTheDocument();
  });

  test('is told who grants access and that it is not instant', async () => {
    // Otherwise the next thing that happens is a reload, then another, then a
    // message asking whether it is broken.
    render(<App store={makeStore()} auth={signedIn()} remote={refusing()} />);
    await screen.findByRole('heading', { name: /does not have access/i });

    // Matched on phrases long enough to identify one element: a short pattern
    // here matches both the paragraph and the <strong> nested inside it, which
    // is a test problem rather than a copy problem.
    expect(screen.getByText(/whoever runs this copy/i)).toBeInTheDocument();
    expect(screen.getByText(/Adding an account means deploying a change/i)).toBeInTheDocument();
  });

  test('can sign out, because it may be the wrong Google account', async () => {
    const user = userEvent.setup();
    const auth = signedIn();
    render(<App store={makeStore()} auth={auth} remote={refusing()} />);
    await screen.findByRole('heading', { name: /does not have access/i });

    await user.click(screen.getByRole('button', { name: /sign out/i }));

    await waitFor(() => expect(auth.state().status).toBe('signedOut'));
  });

  test('can retry in place once the owner has added it', async () => {
    // Being added is a rules deploy, so the reader is sitting on this screen
    // when it happens. Making them guess whether to reload is unkind.
    const user = userEvent.setup();
    const remote = refusingUntilAllowed();
    const store = makeStore();
    await store.addVehicle({ name: 'Civic' });

    render(<App store={store} auth={signedIn()} remote={remote} />);
    await screen.findByRole('heading', { name: /does not have access/i });

    remote.allow();
    await user.click(screen.getByRole('button', { name: /try again/i }));

    expect(await screen.findByRole('navigation', { name: /sections/i })).toBeInTheDocument();
  });

  test('can still export what is already on the device', async () => {
    // The case that makes a hard block unkind: somebody who had access, logged
    // fill-ups, and then lost it would otherwise be unable to reach Settings
    // to get their own data out.
    const store = makeStore();
    const vehicle = await store.addVehicle({ name: 'Civic' });
    const draft = makeFuelEntryDraft({
      date: new Date(2026, 0, 1),
      odometer: 10_000,
      gallons: 10,
      pricePerGallon: 3.5,
    });
    if (draft === null) throw new Error('fixture draft failed validation');
    await store.addFillUp(draft, vehicle.id);

    render(<App store={store} auth={signedIn()} remote={refusing()} />);
    await screen.findByRole('heading', { name: /does not have access/i });

    expect(screen.getByRole('button', { name: /export|save a copy/i })).toBeInTheDocument();
  });

  test('an export from here counts as a backup, like one from Settings (#93)', async () => {
    // It used to download the file and record nothing, so the reminder went on
    // saying "you have never saved a backup" to somebody who just had — the
    // drift `exportBackup.ts` was written to prevent. The fuel log records it
    // now, whichever screen asked.
    Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:x'), writable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), writable: true });
    const store = makeStore();
    const vehicle = await store.addVehicle({ name: 'Civic' });
    for (let i = 0; i < 2; i += 1) {
      const draft = makeFuelEntryDraft({
        date: new Date(2026, 0, 1 + i),
        odometer: 10_000 + i * 300,
        gallons: 10,
        pricePerGallon: 3.5,
      });
      if (draft === null) throw new Error('fixture draft failed validation');
      await store.addFillUp(draft, vehicle.id);
    }
    const user = userEvent.setup();
    render(<App store={store} auth={signedIn()} remote={refusing()} />);
    await screen.findByRole('heading', { name: /does not have access/i });
    expect(loadBackupState(USER.uid).lastExportAt).toBeNull();

    await user.click(screen.getByRole('button', { name: /export|save a copy/i }));

    await waitFor(() => expect(loadBackupState(USER.uid).lastExportAt).not.toBeNull());
    expect(loadBackupState(USER.uid).fillUpsAtLastExport).toBe(2);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  test('is not offered an export when there is nothing to export', async () => {
    render(<App store={makeStore()} auth={signedIn()} remote={refusing()} />);
    await screen.findByRole('heading', { name: /does not have access/i });

    expect(screen.queryByRole('button', { name: /export|save a copy/i })).not.toBeInTheDocument();
  });
});

describe('an ordinary sync failure is not an access problem', () => {
  test('keeps the app open when the account is merely unreachable', async () => {
    // The distinction #40 built. Without it this screen would appear every
    // time a phone went through a tunnel.
    const unreachable: RemoteStore = {
      async pull(): Promise<RawSnapshot> {
        throw new Error('offline');
      },
      async push(): Promise<PushSummary> {
        return { written: 0, receiptsOmitted: 0 };
      },
    };
    const store = makeStore();
    await store.addVehicle({ name: 'Civic' });

    render(<App store={store} auth={signedIn()} remote={unreachable} />);

    expect(await screen.findByRole('navigation', { name: /sections/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /does not have access/i })).not.toBeInTheDocument();
  });

  test('keeps the app open for a build with no backend at all', async () => {
    // remote === null: no Firebase config. Nothing has refused anything.
    render(<App store={makeStore()} auth={signedIn()} remote={null} />);
    expect(await screen.findByRole('heading', { name: /welcome/i })).toBeInTheDocument();
  });
});

describe('a refused change is not a refused account (#50)', () => {
  test('keeps the app open when the account reads fine but refuses a write', async () => {
    // The pull succeeding is what proves the account is allowed. Before #50 a
    // single over-long field made the push fail with the same code as the
    // allowlist, and this screen replaced the app — leaving no way to reach
    // the fill-up that caused it.
    const refusesWrites: RemoteStore = {
      async pull(): Promise<RawSnapshot> {
        return { vehicles: [], fillUps: [], pendingFillUps: [] };
      },
      async push(): Promise<PushSummary> {
        const error = new Error('Missing or insufficient permissions.');
        (error as unknown as Record<string, unknown>)['code'] = 'permission-denied';
        throw error;
      },
    };
    saveHasOnboarded(USER.uid);
    const store = makeStore();
    await store.addVehicle({ name: 'Civic' });

    render(<App store={store} auth={signedIn()} remote={refusesWrites} />);

    expect(await screen.findByRole('navigation', { name: /sections/i })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: /does not have access/i })).not.toBeInTheDocument(),
    );
  });
});
