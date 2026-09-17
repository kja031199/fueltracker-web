// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InMemoryRepository } from '../data/repository';
import type { FillUpRecord, PendingFillUpRecord, VehicleRecord } from '../data/records';
import { FuelTrackerStore } from '../data/store';
import { makeFuelEntryDraft } from '../domain/fuelEntryDraft';
import { App } from './App';

function makeStore(): FuelTrackerStore {
  return new FuelTrackerStore({
    vehicles: new InMemoryRepository<VehicleRecord>(),
    fillUps: new InMemoryRepository<FillUpRecord>(),
    pendingFillUps: new InMemoryRepository<PendingFillUpRecord>(),
  });
}

function draft(overrides: Partial<Parameters<typeof makeFuelEntryDraft>[0]> = {}) {
  const result = makeFuelEntryDraft({
    date: new Date(2025, 0, 15),
    odometer: 10_000,
    gallons: 10,
    pricePerGallon: 3.5,
    ...overrides,
  });
  if (result === null) throw new Error('fixture draft failed validation');
  return result;
}

async function setUp(
  seed: (store: FuelTrackerStore, vehicleId: string) => Promise<void> = async () => {},
  tab: 'fillups' | 'dashboard' = 'fillups',
): Promise<FuelTrackerStore> {
  localStorage.setItem('fueltracker.hasOnboarded', 'true');
  const store = makeStore();
  const vehicle = await store.addVehicle({ name: 'Daily Driver' });
  await seed(store, vehicle.id);
  render(<App store={store} initialTab={tab} />);
  return store;
}

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe('logging a fill-up', () => {
  test('saves what was typed and shows it in the list', async () => {
    const user = userEvent.setup();
    const store = await setUp();

    await user.click(await screen.findByRole('button', { name: /log a fill-up/i }));
    await user.type(screen.getByLabelText(/odometer/i), '10000');
    await user.type(screen.getByLabelText('Gallons'), '10');
    await user.type(screen.getByLabelText(/price per gallon/i), '3.5');
    await user.type(screen.getByLabelText(/gas station/i), 'Shell');
    await user.click(screen.getByRole('button', { name: /save fill-up/i }));

    await waitFor(async () => {
      const vehicles = await store.vehicles();
      expect(await store.fillUps(vehicles[0]!.id)).toHaveLength(1);
    });
    // Scoped to the list: "Shell" also appears in the station filter, which is
    // correct behaviour and not what this test is about.
    const list = await screen.findByRole('list');
    expect(within(list).getByText(/Shell/)).toBeInTheDocument();
    expect(within(list).getByText('$35.00')).toBeInTheDocument();
  });

  test('the save button stays disabled until the form is valid', async () => {
    const user = userEvent.setup();
    await setUp();
    await user.click(await screen.findByRole('button', { name: /log a fill-up/i }));

    const save = screen.getByRole('button', { name: /save fill-up/i });
    expect(save).toBeDisabled();

    await user.type(screen.getByLabelText(/odometer/i), '10000');
    expect(save).toBeDisabled(); // gallons and price still missing
    await user.type(screen.getByLabelText('Gallons'), '10');
    expect(save).toBeDisabled();
    await user.type(screen.getByLabelText(/price per gallon/i), '3.5');
    expect(save).toBeEnabled();
  });

  test('a zero-gallon fill cannot be saved', async () => {
    const user = userEvent.setup();
    await setUp();
    await user.click(await screen.findByRole('button', { name: /log a fill-up/i }));
    await user.type(screen.getByLabelText(/odometer/i), '10000');
    await user.type(screen.getByLabelText('Gallons'), '0');
    await user.type(screen.getByLabelText(/price per gallon/i), '3.5');
    expect(screen.getByRole('button', { name: /save fill-up/i })).toBeDisabled();
  });

  test('shows the running total as the numbers go in', async () => {
    const user = userEvent.setup();
    await setUp();
    await user.click(await screen.findByRole('button', { name: /log a fill-up/i }));
    await user.type(screen.getByLabelText('Gallons'), '10');
    await user.type(screen.getByLabelText(/price per gallon/i), '3.5');
    expect(screen.getByText('$35.00')).toBeInTheDocument();
  });

  test('warns when the odometer is at or below the last reading', async () => {
    const user = userEvent.setup();
    await setUp(async (store, vehicleId) => {
      await store.addFillUp(draft({ odometer: 12_000 }), vehicleId);
    });

    await user.click(await screen.findByRole('button', { name: /log a fill-up/i }));
    await user.type(screen.getByLabelText(/odometer/i), '11000');

    const warning = await screen.findByRole('status');
    expect(warning).toHaveTextContent(/at or below the last reading/i);
    // A warning, not a block: the entry is still saveable.
    await user.type(screen.getByLabelText('Gallons'), '10');
    await user.type(screen.getByLabelText(/price per gallon/i), '3.5');
    expect(screen.getByRole('button', { name: /save fill-up/i })).toBeEnabled();
  });

  test('editing an existing fill-up keeps one row rather than adding another', async () => {
    const user = userEvent.setup();
    const store = await setUp(async (s, vehicleId) => {
      await s.addFillUp(draft({ station: 'Shell' }), vehicleId);
    });

    await user.click(await screen.findByRole('button', { name: /^edit$/i }));
    const station = screen.getByLabelText(/gas station/i);
    await user.clear(station);
    await user.type(station, 'Costco');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    const vehicles = await store.vehicles();
    await waitFor(async () => {
      const rows = await store.fillUps(vehicles[0]!.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.station).toBe('Costco');
    });
  });

  test('deleting asks first', async () => {
    const user = userEvent.setup();
    const store = await setUp(async (s, vehicleId) => {
      await s.addFillUp(draft(), vehicleId);
    });

    await user.click(await screen.findByRole('button', { name: /^delete$/i }));
    const vehicles = await store.vehicles();
    expect(await store.fillUps(vehicles[0]!.id)).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: /delete this fill-up/i }));
    await waitFor(async () => expect(await store.fillUps(vehicles[0]!.id)).toHaveLength(0));
  });
});

describe('units convert at the entry boundary', () => {
  test('typing litres stores gallons', async () => {
    // The rule the whole units system rests on: storage stays canonical, and
    // conversion happens only where a person types or reads a number.
    const user = userEvent.setup();
    localStorage.setItem(
      'fueltracker.units',
      JSON.stringify({ volume: 'liters', distance: 'kilometers', economy: 'litersPer100km' }),
    );
    const store = await setUp();

    await user.click(await screen.findByRole('button', { name: /log a fill-up/i }));
    expect(screen.getByLabelText('Liters')).toBeInTheDocument();
    await user.type(screen.getByLabelText(/odometer \(km\)/i), '16093.44');
    await user.type(screen.getByLabelText('Liters'), '37.854');
    await user.type(screen.getByLabelText(/price per liter/i), '1');
    await user.click(screen.getByRole('button', { name: /save fill-up/i }));

    const vehicles = await store.vehicles();
    await waitFor(async () => {
      const [record] = await store.fillUps(vehicles[0]!.id);
      expect(record).toBeDefined();
      expect(record!.gallons).toBeCloseTo(10, 3);
      expect(record!.odometer).toBeCloseTo(10_000, 1);
      // A dollar a litre is about $3.79 a gallon, stored canonically.
      expect(record!.pricePerGallon).toBeCloseTo(3.785, 3);
    });
  });
});

describe('the fill-up list filter', () => {
  const seedThree = async (store: FuelTrackerStore, vehicleId: string): Promise<void> => {
    await store.addFillUp(draft({ odometer: 10_000, station: 'Shell' }), vehicleId);
    await store.addFillUp(
      draft({ odometer: 10_400, station: 'Costco', fuelGrade: 'Premium' }),
      vehicleId,
    );
    await store.addFillUp(draft({ odometer: 10_800, station: 'Shell' }), vehicleId);
  };

  test('narrows the list by search text', async () => {
    const user = userEvent.setup();
    await setUp(seedThree);
    expect(await screen.findByText('3 of 3 fill-ups')).toBeInTheDocument();

    await user.type(screen.getByLabelText(/search station or notes/i), 'costco');
    expect(await screen.findByText('1 of 3 fill-ups')).toBeInTheDocument();
  });

  test('narrows by grade and can be cleared', async () => {
    const user = userEvent.setup();
    await setUp(seedThree);
    await user.selectOptions(await screen.findByLabelText(/fuel grade/i), 'Premium');
    expect(await screen.findByText('1 of 3 fill-ups')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /clear filters/i }));
    expect(await screen.findByText('3 of 3 fill-ups')).toBeInTheDocument();
  });

  test('says so when nothing matches, rather than looking empty', async () => {
    const user = userEvent.setup();
    await setUp(seedThree);
    await user.type(await screen.findByLabelText(/search station or notes/i), 'zzz');
    expect(await screen.findByText(/nothing matches those filters/i)).toBeInTheDocument();
  });
});

describe('the dashboard', () => {
  test('reports economy once there are two full tanks', async () => {
    await setUp(async (store, vehicleId) => {
      await store.addFillUp(draft({ date: new Date(2025, 0, 1), odometer: 10_000 }), vehicleId);
      await store.addFillUp(draft({ date: new Date(2025, 0, 11), odometer: 10_400 }), vehicleId);
    }, 'dashboard');

    const card = await screen.findByLabelText(/^Avg MPG, 40\.0$/);
    expect(card).toBeInTheDocument();
  });

  test('says "no data yet" rather than showing a zero', async () => {
    await setUp(async (store, vehicleId) => {
      await store.addFillUp(draft(), vehicleId);
    }, 'dashboard');
    expect(await screen.findByLabelText(/^Avg MPG, no data yet$/)).toBeInTheDocument();
  });

  test('invites a first fill-up when there are none', async () => {
    await setUp(async () => {}, 'dashboard');
    expect(await screen.findByText(/no fill-ups yet/i)).toBeInTheDocument();
  });

  test('flags a segment that looks like an unlogged fill', async () => {
    await setUp(async (store, vehicleId) => {
      // 400 miles on 10 gallons, then 4,000 miles on 10 — the classic
      // signature of a fill-up that never got logged.
      await store.addFillUp(draft({ date: new Date(2025, 0, 1), odometer: 10_000 }), vehicleId);
      await store.addFillUp(draft({ date: new Date(2025, 0, 11), odometer: 10_400 }), vehicleId);
      await store.addFillUp(draft({ date: new Date(2025, 0, 21), odometer: 10_800 }), vehicleId);
      await store.addFillUp(draft({ date: new Date(2025, 1, 1), odometer: 14_800 }), vehicleId);
    }, 'dashboard');

    expect(await screen.findByText(/looks like a fill-up went unlogged/i)).toBeInTheDocument();
  });
});
