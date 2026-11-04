// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InMemoryRepository } from '../data/repository';
import type { FillUpRecord, PendingFillUpRecord, VehicleRecord } from '../data/records';
import { FuelTrackerStore } from '../data/store';
import { makeFuelEntryDraft } from '../domain/fuelEntryDraft';
import { App } from './App';
import { saveHasOnboarded } from './onboarding';

/**
 * "Did somebody forget to log a fill-up?" in the form (#66): a warning, never a
 * block, when the distance since the last fill-up is unusually long.
 */

async function carEvery300(): Promise<FuelTrackerStore> {
  const store = new FuelTrackerStore({
    vehicles: new InMemoryRepository<VehicleRecord>(),
    fillUps: new InMemoryRepository<FillUpRecord>(),
    pendingFillUps: new InMemoryRepository<PendingFillUpRecord>(),
  });
  const car = await store.addVehicle({ name: 'Civic' });
  for (const [i, odometer] of [10_000, 10_300, 10_600, 10_900].entries()) {
    const draft = makeFuelEntryDraft({ date: new Date(2026, 0, 1 + i * 7), odometer, gallons: 10, pricePerGallon: 3.5 });
    if (draft === null) throw new Error('fixture draft failed validation');
    await store.addFillUp(draft, car.id);
  }
  return store;
}

async function openForm(store: FuelTrackerStore): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  render(<App store={store} initialTab="fillups" />);
  await user.click(await screen.findByRole('button', { name: /log a fill-up/i }));
  return user;
}

beforeEach(() => {
  localStorage.clear();
  saveHasOnboarded('local');
});

afterEach(cleanup);

describe('the missed fill-up hint', () => {
  test('appears for a jump of more than twice the usual distance, and says by how much', async () => {
    const user = await openForm(await carEvery300());
    await user.type(screen.getByLabelText(/odometer/i), '11550');
    const hint = await screen.findByText(/650 mi since the last fill-up/i);
    expect(hint).toHaveTextContent(/usual 300 mi/i);
    expect(hint).toHaveTextContent(/missed logging a fill before this one/i);
  });

  test('does not appear for an ordinary fill-up', async () => {
    const user = await openForm(await carEvery300());
    await user.type(screen.getByLabelText(/odometer/i), '11200');
    expect(screen.queryByText(/since the last fill-up/i)).not.toBeInTheDocument();
  });

  test('goes away once the missed box is ticked — the hint has done its job', async () => {
    const user = await openForm(await carEvery300());
    await user.type(screen.getByLabelText(/odometer/i), '11550');
    await screen.findByText(/since the last fill-up/i);
    await user.click(screen.getByLabelText(/missed logging a fill before this one/i));
    expect(screen.queryByText(/since the last fill-up/i)).not.toBeInTheDocument();
  });

  test('never blocks saving', async () => {
    const store = await carEvery300();
    const user = await openForm(store);
    await user.type(screen.getByLabelText(/odometer/i), '11550');
    await user.type(screen.getByLabelText('Gallons'), '10');
    await user.type(screen.getByLabelText(/price per gallon/i), '3.5');
    await screen.findByText(/since the last fill-up/i);
    await user.click(screen.getByRole('button', { name: /save fill-up/i }));
    expect(await store.fillUpCount()).toBe(5);
  });

  test('stays quiet on a new car with too little history to judge', async () => {
    const store = new FuelTrackerStore({
      vehicles: new InMemoryRepository<VehicleRecord>(),
      fillUps: new InMemoryRepository<FillUpRecord>(),
      pendingFillUps: new InMemoryRepository<PendingFillUpRecord>(),
    });
    const car = await store.addVehicle({ name: 'New' });
    const draft = makeFuelEntryDraft({ date: new Date(2026, 0, 1), odometer: 10_000, gallons: 10, pricePerGallon: 3.5 });
    await store.addFillUp(draft!, car.id);
    const user = await openForm(store);
    await user.type(screen.getByLabelText(/odometer/i), '19000');
    expect(screen.queryByText(/since the last fill-up/i)).not.toBeInTheDocument();
  });

  test('does not double up with the odometer-went-backwards warning', async () => {
    const user = await openForm(await carEvery300());
    await user.type(screen.getByLabelText(/odometer/i), '10500');
    expect(screen.queryByText(/since the last fill-up/i)).not.toBeInTheDocument();
  });

  test('a reading below the latest gets the backwards warning alone, even when it would also be a long jump', async () => {
    // 10,000 · 10,300 · 10,600 · 10,900 · 12,500. 11,800 is below the latest
    // (a likely typo — the warning that matters) but also 900 past 10,900.
    // One warning, not two that contradict each other.
    const store = await carEvery300();
    const [car] = await store.vehicles();
    const draft = makeFuelEntryDraft({ date: new Date(2026, 1, 1), odometer: 12_500, gallons: 10, pricePerGallon: 3.5 });
    await store.addFillUp(draft!, car!.id);
    const user = await openForm(store);
    await user.type(screen.getByLabelText(/odometer/i), '11800');
    expect(await screen.findByText(/at or below the last reading/i)).toBeInTheDocument();
    expect(screen.queryByText(/since the last fill-up/i)).not.toBeInTheDocument();
  });

  test('uses the reader’s units', async () => {
    localStorage.setItem('fueltracker.units', JSON.stringify({ volume: 'liters', distance: 'kilometers', economy: 'litersPer100km' }));
    const user = await openForm(await carEvery300());
    // 11,550 mi is 18,588 km; type the km reading.
    await user.type(screen.getByLabelText(/odometer/i), '18588');
    expect(await screen.findByText(/km since the last fill-up/i)).toBeInTheDocument();
  });

  test('an edit is measured from the reading before it — never from its own old value', async () => {
    // 10,000 · 10,300 · 10,600 · 10,900 · 11,200. Moving the newest to 11,600
    // is 700 mi from 10,900 — unusual. Measured against its own old 11,200 it
    // would look like a quiet 400.
    const store = await carEvery300();
    const [car] = await store.vehicles();
    const draft = makeFuelEntryDraft({ date: new Date(2026, 1, 1), odometer: 11_200, gallons: 10, pricePerGallon: 3.5 });
    await store.addFillUp(draft!, car!.id);
    const user = userEvent.setup();
    render(<App store={store} initialTab="fillups" />);
    const edits = await screen.findAllByRole('button', { name: /^edit/i });
    await user.click(edits[0]!);
    const odometer = await screen.findByLabelText(/odometer/i);
    expect(screen.queryByText(/since the last fill-up/i)).not.toBeInTheDocument();
    await user.clear(odometer);
    await user.type(odometer, '11600');
    expect(await screen.findByText(/700 mi since the last fill-up/i)).toBeInTheDocument();
  });
});

