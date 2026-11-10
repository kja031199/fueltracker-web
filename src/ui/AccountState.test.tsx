// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { makeStore } from '../test/fixtures';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StubAuthProvider } from '../data/auth';
import type { RemoteStore } from '../data/remote';
import { InMemoryRemoteStore } from '../data/remote';
import { FuelTrackerStore } from '../data/store';
import { makeFuelEntryDraft } from '../domain/fuelEntryDraft';
import { MINIMUM_ENTRIES_TO_PROMPT } from '../domain/exportReminder';
import { App } from './App';

/**
 * Two accounts, one browser (#55).
 *
 * Local *data* has been separated per account since #44. These pin the same
 * for local *state*: each test does something as account A, then signs in as
 * B on the same device and checks that B does not inherit it. Every one of
 * them failed before the state was scoped to the account.
 */

const A = { uid: 'account-a', email: 'a@example.com', displayName: 'A' };
const B = { uid: 'account-b', email: 'b@example.com', displayName: 'B' };

const as = (user: typeof A): StubAuthProvider =>
  new StubAuthProvider({ status: 'signedIn', user });

function emptyStore(): FuelTrackerStore {
  return makeStore();
}

async function storeWith(fillUps: number): Promise<FuelTrackerStore> {
  const store = emptyStore();
  const vehicle = await store.addVehicle({ name: 'Civic' });
  for (let i = 0; i < fillUps; i += 1) {
    const draft = makeFuelEntryDraft({
      date: new Date(2026, 0, 1 + i),
      odometer: 10_000 + i * 300,
      gallons: 10,
      pricePerGallon: 3.5,
    });
    if (draft === null) throw new Error('fixture draft failed validation');
    await store.addFillUp(draft, vehicle.id);
  }
  return store;
}

/** A remote that never answers, so a sync neither succeeds nor records a time. */
function silentRemote(): RemoteStore {
  const never = (): Promise<never> => new Promise(() => {});
  return { pull: never, push: never } as unknown as RemoteStore;
}

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:x'), writable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), writable: true });
});

afterEach(cleanup);

describe('one browser, two accounts', () => {
  test("A's backup does not silence B's reminder", async () => {
    // The case the issue exists for: B holds data that exists nowhere else,
    // and goes unprompted because A exported recently.
    const user = userEvent.setup();
    render(<App store={await storeWith(MINIMUM_ENTRIES_TO_PROMPT)} auth={as(A)} />);
    await user.click(await screen.findByRole('button', { name: /save a backup/i }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /save a backup/i })).not.toBeInTheDocument(),
    );
    cleanup();

    render(<App store={await storeWith(MINIMUM_ENTRIES_TO_PROMPT)} auth={as(B)} />);
    expect(await screen.findByText(/never saved a backup/i)).toBeInTheDocument();
  });

  test('and A, signing back in, still has their own backup recorded', async () => {
    const user = userEvent.setup();
    render(<App store={await storeWith(MINIMUM_ENTRIES_TO_PROMPT)} auth={as(A)} />);
    await user.click(await screen.findByRole('button', { name: /save a backup/i }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /save a backup/i })).not.toBeInTheDocument(),
    );
    cleanup();
    render(<App store={await storeWith(MINIMUM_ENTRIES_TO_PROMPT)} auth={as(B)} />);
    await screen.findByText(/never saved a backup/i);
    cleanup();

    render(<App store={await storeWith(MINIMUM_ENTRIES_TO_PROMPT)} auth={as(A)} />);
    await screen.findByRole('navigation', { name: /sections/i });
    expect(screen.queryByRole('button', { name: /save a backup/i })).not.toBeInTheDocument();
  });

  test("Settings does not show B the time of A's last sync", async () => {
    render(
      <App store={await storeWith(1)} auth={as(A)} remote={new InMemoryRemoteStore()} initialTab="settings" />,
    );
    expect(await screen.findByText(/last synced just now/i)).toBeInTheDocument();
    cleanup();

    render(<App store={await storeWith(1)} auth={as(B)} remote={silentRemote()} initialTab="settings" />);
    expect(await screen.findByText(/last synced not yet/i)).toBeInTheDocument();
  });

  test("A's last sync time is still there when A comes back", async () => {
    // Scoping must not turn into forgetting: the time is stored for A, not
    // merely held in memory until the page goes away.
    render(
      <App store={await storeWith(1)} auth={as(A)} remote={new InMemoryRemoteStore()} initialTab="settings" />,
    );
    await screen.findByText(/last synced just now/i);
    cleanup();

    render(<App store={await storeWith(1)} auth={as(B)} remote={silentRemote()} initialTab="settings" />);
    await screen.findByText(/last synced not yet/i);
    cleanup();

    render(<App store={await storeWith(1)} auth={as(A)} remote={silentRemote()} initialTab="settings" />);
    expect(await screen.findByText(/last synced just now/i)).toBeInTheDocument();
  });

  test('B is welcomed even though A already was', async () => {
    const user = userEvent.setup();
    render(<App store={emptyStore()} auth={as(A)} />);
    await user.click(await screen.findByRole('button', { name: /get started/i }));
    await screen.findByRole('navigation', { name: /sections/i });
    cleanup();

    render(<App store={emptyStore()} auth={as(B)} />);
    expect(await screen.findByRole('heading', { name: /welcome to fueltracker/i })).toBeInTheDocument();
  });
});

describe('state written before it was scoped to an account', () => {
  // Nobody can say which account wrote an unscoped value, so adopting it would
  // hand one account's state to whoever signs in next — the #44 mistake again.
  test('a recent unscoped backup marker is not adopted, and is removed', async () => {
    localStorage.setItem(
      'fueltracker.lastBackup',
      JSON.stringify({ lastExportAt: Date.now(), fillUpsAtLastExport: 99, snoozedUntil: null }),
    );
    render(<App store={await storeWith(MINIMUM_ENTRIES_TO_PROMPT)} auth={as(B)} />);
    expect(await screen.findByText(/never saved a backup/i)).toBeInTheDocument();
    expect(localStorage.getItem('fueltracker.lastBackup')).toBeNull();
  });

  test('an unscoped onboarding flag is not adopted, and is removed', async () => {
    localStorage.setItem('fueltracker.hasOnboarded', 'true');
    render(<App store={emptyStore()} auth={as(B)} />);
    expect(await screen.findByRole('heading', { name: /welcome to fueltracker/i })).toBeInTheDocument();
    expect(localStorage.getItem('fueltracker.hasOnboarded')).toBeNull();
  });

  test('an unscoped last-synced time is not adopted, and is removed', async () => {
    localStorage.setItem('fueltracker.lastSyncedAt', String(Date.now()));
    render(<App store={await storeWith(1)} auth={as(B)} remote={silentRemote()} initialTab="settings" />);
    expect(await screen.findByText(/last synced not yet/i)).toBeInTheDocument();
    expect(localStorage.getItem('fueltracker.lastSyncedAt')).toBeNull();
  });

  test('browser-wide settings are kept as they are', async () => {
    // Units and the idle timeout are about the device, not the account, so
    // they stay where they were and are still honoured.
    localStorage.setItem('fueltracker.units', JSON.stringify({ volume: 'liters', distance: 'kilometers', economy: 'litersPer100km' }));
    render(<App store={await storeWith(1)} auth={as(B)} initialTab="settings" />);
    await screen.findByRole('navigation', { name: /sections/i });
    expect(localStorage.getItem('fueltracker.units')).toContain('liters');
  });
});
