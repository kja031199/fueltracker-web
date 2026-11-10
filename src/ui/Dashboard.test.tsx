import { beforeEach, describe, expect, test } from 'vitest';
import { makeStore } from '../test/fixtures';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { makeFuelEntryDraft } from '../domain/fuelEntryDraft';
import { App } from './App';
import { saveHasOnboarded } from './onboarding';

/**
 * The range picker on the dashboard (#51).
 *
 * "3M" used to filter fill-ups and then compute, so the one fill-up of the last
 * three months had no predecessor and its economy read "no data yet" — while
 * the segment ending there, which started two weeks before the cutoff, was
 * perfectly computable.
 */
beforeEach(() => localStorage.clear());

const DAY = 86_400_000;

test('a range admitting one fill-up still shows the economy of the drive that ended in it', async () => {
  const store = makeStore();
  const vehicle = await store.addVehicle({ name: 'Daily Driver' });
  const now = Date.now();
  // 300 miles on 10 gallons each time: 30 MPG. Only the last is inside 3M.
  for (const [daysAgo, odometer] of [[130, 10_000], [116, 10_300], [102, 10_600], [10, 10_900]] as const) {
    const draft = makeFuelEntryDraft({ date: new Date(now - daysAgo * DAY), odometer, gallons: 10, pricePerGallon: 3 });
    if (draft === null) throw new Error('fixture draft failed validation');
    await store.addFillUp(draft, vehicle.id);
  }
  saveHasOnboarded('local');
  const user = userEvent.setup();

  render(<App store={store} initialTab="dashboard" />);
  await user.selectOptions(await screen.findByLabelText(/time range/i), '3M');

  expect(screen.getByRole('listitem', { name: /^Avg MPG/ })).toHaveAccessibleName(/^Avg MPG, 30/);
});

describe('the range still narrows what it should', () => {
  test('fill-up count reflects only the range', async () => {
    const store = makeStore();
    const vehicle = await store.addVehicle({ name: 'Daily Driver' });
    const now = Date.now();
    for (const [daysAgo, odometer] of [[200, 10_000], [10, 10_300]] as const) {
      const draft = makeFuelEntryDraft({ date: new Date(now - daysAgo * DAY), odometer, gallons: 10, pricePerGallon: 3 });
      if (draft === null) throw new Error('fixture draft failed validation');
      await store.addFillUp(draft, vehicle.id);
    }
    saveHasOnboarded('local');
    const user = userEvent.setup();

    render(<App store={store} initialTab="dashboard" />);
    await user.selectOptions(await screen.findByLabelText(/time range/i), '3M');

    expect(screen.getByRole('listitem', { name: /^Fill-Ups/ })).toHaveAccessibleName(/^Fill-Ups, 1\b/);
  });
});
