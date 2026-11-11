import { beforeEach, describe, expect, test } from 'vitest';
import { makeStore, saveHasOnboarded } from '../test/fixtures';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FuelTrackerStore } from '../data/store';
import { makeFuelEntryDraft } from '../domain/fuelEntryDraft';
import { App } from './App';
import { TAB_TABLE, TABS, parseTab, hashFor } from './useTabRoute';

/**
 * Switching tabs keeps what you were doing (#93).
 *
 * Each tab's screen used to be unmounted when another was chosen, so a
 * half-typed fill-up, the fill-ups filter and the dashboard's range were all
 * gone on the way back. The PWA refuses to auto-update for exactly this
 * reason — to keep a half-typed fill-up — and then the app threw it away
 * itself at the first tab switch. A visited tab is now kept, hidden.
 */

async function setUp(tab: 'fillups' | 'dashboard' = 'fillups'): Promise<FuelTrackerStore> {
  saveHasOnboarded('local');
  const store = makeStore();
  const vehicle = await store.addVehicle({ name: 'Daily Driver' });
  for (const [i, odometer] of [10_000, 10_300].entries()) {
    const draft = makeFuelEntryDraft({
      date: new Date(2026, 0, 1 + i * 7),
      odometer,
      gallons: 10,
      pricePerGallon: 3.5,
    });
    if (draft === null) throw new Error('fixture draft failed validation');
    await store.addFillUp(draft, vehicle.id);
  }
  render(<App store={store} initialTab={tab} />);
  await screen.findByRole('navigation', { name: /sections/i });
  return store;
}

// Role queries, not label or text ones: a hidden tab is still in the page,
// and a role query is what skips it — as a screen reader would.
const go = async (user: ReturnType<typeof userEvent.setup>, label: string): Promise<void> => {
  await user.click(screen.getByRole('button', { name: label }));
};

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('a tab keeps its state while another is shown', () => {
  test('a half-typed fill-up is still there, as typed', async () => {
    const user = userEvent.setup();
    await setUp();
    await user.click(await screen.findByRole('button', { name: /log a fill-up/i }));
    await user.type(screen.getByRole('textbox', { name: /odometer/i }), '10600.5');
    await user.type(screen.getByRole('textbox', { name: /price per gallon/i }), '3.');

    await go(user, 'Dashboard');
    await go(user, 'Fill-ups');

    expect(screen.getByRole('textbox', { name: /odometer/i })).toHaveValue('10600.5');
    // Mid-decimal, exactly as left: the text is kept, not a re-rendered number.
    expect(screen.getByRole('textbox', { name: /price per gallon/i })).toHaveValue('3.');
  });

  test('the fill-ups filter is still set', async () => {
    const user = userEvent.setup();
    await setUp();
    await user.type(await screen.findByLabelText(/search station or notes/i), 'Shell');
    await go(user, 'Vehicles');
    await go(user, 'Fill-ups');
    expect(screen.getByLabelText(/search station or notes/i)).toHaveValue('Shell');
  });

  test('the dashboard’s range is still chosen', async () => {
    const user = userEvent.setup();
    await setUp('dashboard');
    await user.selectOptions(await screen.findByLabelText(/time range/i), '3M');
    await go(user, 'Settings');
    await go(user, 'Dashboard');
    expect(screen.getByLabelText(/time range/i)).toHaveValue('3M');
  });

  test('a saved fill-up is not brought back as a draft', async () => {
    const user = userEvent.setup();
    await setUp();
    await user.click(await screen.findByRole('button', { name: /log a fill-up/i }));
    await user.type(screen.getByRole('textbox', { name: /odometer/i }), '10600');
    await user.type(screen.getByRole('textbox', { name: 'Gallons' }), '10');
    await user.type(screen.getByRole('textbox', { name: /price per gallon/i }), '3.5');
    await user.click(screen.getByRole('button', { name: /save fill-up/i }));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: /odometer/i })).toBeNull());

    await go(user, 'Dashboard');
    await go(user, 'Fill-ups');
    expect(screen.queryByRole('textbox', { name: /odometer/i })).toBeNull();
  });
});

describe('a hidden tab is out of the way', () => {
  test('its controls cannot be reached, and only one page title shows', async () => {
    const user = userEvent.setup();
    await setUp();
    await go(user, 'Dashboard');
    expect(screen.queryByRole('button', { name: /log a fill-up/i })).toBeNull();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  test('a tab never visited is not rendered at all', async () => {
    await setUp();
    expect(document.getElementById('dashboard-range')).toBeNull();
    expect(document.getElementById('vehicle-name')).toBeNull();
  });
});

describe('the tab list is written once', () => {
  test('the bar shows every tab, in order, with its label', async () => {
    await setUp();
    const bar = screen.getByRole('navigation', { name: /sections/i });
    const labels = [...bar.querySelectorAll('button')].map((button) => button.textContent);
    expect(labels).toEqual(TAB_TABLE.map((entry) => entry.label));
  });

  test('every tab’s address reads back as that tab', () => {
    for (const tab of TABS) expect(parseTab(hashFor(tab))).toBe(tab);
    expect(new Set(TABS).size).toBe(TABS.length);
  });
});
