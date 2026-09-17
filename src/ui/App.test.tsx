// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InMemoryRepository } from '../data/repository';
import type { FillUpRecord, PendingFillUpRecord, VehicleRecord } from '../data/records';
import { FuelTrackerStore } from '../data/store';
import { App } from './App';

function makeStore(): FuelTrackerStore {
  return new FuelTrackerStore({
    vehicles: new InMemoryRepository<VehicleRecord>(),
    fillUps: new InMemoryRepository<FillUpRecord>(),
    pendingFillUps: new InMemoryRepository<PendingFillUpRecord>(),
  });
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(cleanup);

describe('first run', () => {
  test('a new reader is welcomed rather than dropped into an empty dashboard', async () => {
    render(<App store={makeStore()} />);
    expect(await screen.findByRole('heading', { name: /welcome/i })).toBeInTheDocument();
    // The tab bar is not shown yet — there is nothing to navigate to.
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  test('getting started dismisses it for good', async () => {
    const user = userEvent.setup();
    render(<App store={makeStore()} />);
    await user.click(await screen.findByRole('button', { name: /get started/i }));
    expect(await screen.findByRole('navigation', { name: /sections/i })).toBeInTheDocument();

    // And it stays dismissed across a reload, which is the whole point of the
    // flag — being welcomed twice is worse than not being welcomed at all.
    cleanup();
    render(<App store={makeStore()} />);
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: /welcome/i })).not.toBeInTheDocument(),
    );
  });

  test('a reader who already has vehicles is never onboarded', async () => {
    // The case the gate exists for: an imported backup or a second browser
    // profile, where the flag was never set but the data is already there.
    const store = makeStore();
    await store.addVehicle({ name: 'Existing' });
    render(<App store={store} />);
    expect(await screen.findByRole('navigation', { name: /sections/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /welcome/i })).not.toBeInTheDocument();
  });
});

describe('vehicles', () => {
  async function renderPastOnboarding(store: FuelTrackerStore): Promise<void> {
    localStorage.setItem('fueltracker.hasOnboarded', 'true');
    render(<App store={store} initialTab="vehicles" />);
    await screen.findByRole('heading', { name: /add a vehicle/i });
  }

  test('adding a vehicle shows it in the list', async () => {
    const user = userEvent.setup();
    const store = makeStore();
    await renderPastOnboarding(store);

    await user.type(screen.getByLabelText('Name'), 'Daily Driver');
    await user.type(screen.getByLabelText('Make'), 'Honda');
    await user.type(screen.getByLabelText('Model'), 'Civic');
    await user.click(screen.getByRole('button', { name: /add vehicle/i }));

    const list = await screen.findByRole('list');
    expect(within(list).getByText('Daily Driver')).toBeInTheDocument();
    // The subtitle reads as a car, not as three separate fields.
    expect(within(list).getByText(/Honda Civic/)).toBeInTheDocument();
    expect(await store.vehicles()).toHaveLength(1);
  });

  test('a nameless vehicle cannot be added', async () => {
    const store = makeStore();
    await renderPastOnboarding(store);
    expect(screen.getByRole('button', { name: /add vehicle/i })).toBeDisabled();
  });

  test('deleting asks first, because the history goes with it', async () => {
    const user = userEvent.setup();
    const store = makeStore();
    await store.addVehicle({ name: 'Old Car' });
    await renderPastOnboarding(store);

    await user.click(await screen.findByRole('button', { name: /^delete$/i }));
    // Nothing is gone yet — the confirmation names what will be lost.
    expect(await store.vehicles()).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: /delete old car and its fill-ups/i }));
    await waitFor(async () => expect(await store.vehicles()).toHaveLength(0));
  });

  test('backing out of a delete keeps the vehicle', async () => {
    const user = userEvent.setup();
    const store = makeStore();
    await store.addVehicle({ name: 'Old Car' });
    await renderPastOnboarding(store);

    await user.click(await screen.findByRole('button', { name: /^delete$/i }));
    await user.click(screen.getByRole('button', { name: /keep/i }));
    expect(await store.vehicles()).toHaveLength(1);
    expect(screen.getByRole('button', { name: /^delete$/i })).toBeInTheDocument();
  });
});

describe('settings', () => {
  async function renderSettings(): Promise<void> {
    localStorage.setItem('fueltracker.hasOnboarded', 'true');
    const store = makeStore();
    await store.addVehicle({ name: 'Car' });
    render(<App store={store} initialTab="settings" />);
    await screen.findByRole('heading', { name: /units/i });
  }

  test('offers every unit and remembers the choice', async () => {
    const user = userEvent.setup();
    await renderSettings();

    await user.selectOptions(screen.getByLabelText(/volume/i), 'liters');
    await user.selectOptions(screen.getByLabelText(/fuel economy/i), 'litersPer100km');

    expect(localStorage.getItem('fueltracker.units')).toContain('liters');
    expect(localStorage.getItem('fueltracker.units')).toContain('litersPer100km');
  });

  test('says plainly that clearing browser data loses the log', async () => {
    // The most likely way this app hurts someone, so it is stated rather than
    // buried — and it will stay stated until export exists.
    await renderSettings();
    expect(screen.getByText(/clearing your browser data will delete your fuel log/i))
      .toBeInTheDocument();
  });
});

describe('navigation', () => {
  test('marks the current tab for assistive technology, not just visually', async () => {
    const user = userEvent.setup();
    localStorage.setItem('fueltracker.hasOnboarded', 'true');
    const store = makeStore();
    await store.addVehicle({ name: 'Car' });
    render(<App store={store} />);

    const nav = await screen.findByRole('navigation', { name: /sections/i });
    const vehicles = within(nav).getByRole('button', { name: 'Vehicles' });
    await user.click(vehicles);
    expect(vehicles).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('button', { name: 'Settings' })).not.toHaveAttribute(
      'aria-current',
    );
  });
});
