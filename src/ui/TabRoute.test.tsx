// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InMemoryRepository } from '../data/repository';
import type { FillUpRecord, PendingFillUpRecord, VehicleRecord } from '../data/records';
import { FuelTrackerStore } from '../data/store';
import { App } from './App';
import { saveHasOnboarded } from './onboarding';
import { parseTab } from './useTabRoute';

/**
 * Tabs live in the URL hash (#56).
 *
 * They used to be React state, so a reload always landed on Dashboard, the
 * phone's Back button left the app instead of going back a tab, and nothing
 * could link to Settings.
 */

function makeStore(): FuelTrackerStore {
  return new FuelTrackerStore({
    vehicles: new InMemoryRepository<VehicleRecord>(),
    fillUps: new InMemoryRepository<FillUpRecord>(),
    pendingFillUps: new InMemoryRepository<PendingFillUpRecord>(),
  });
}

const current = (): string | null =>
  screen
    .getAllByRole('button')
    .find((button) => button.getAttribute('aria-current') === 'page')
    ?.textContent ?? null;

async function openApp(): Promise<void> {
  render(<App store={makeStore()} />);
  await screen.findByRole('navigation', { name: /sections/i });
}

/** The real browser fires `hashchange` asynchronously after history moves. */
async function back(): Promise<void> {
  await act(async () => {
    window.history.back();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

beforeEach(() => {
  localStorage.clear();
  saveHasOnboarded('local');
  window.history.replaceState(null, '', '/');
});

afterEach(cleanup);

describe('the tab is in the address', () => {
  test('choosing a tab puts it in the hash', async () => {
    const user = userEvent.setup();
    await openApp();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(window.location.hash).toBe('#/settings');
    expect(current()).toBe('Settings');
  });

  test('a reload lands on the tab it left', async () => {
    window.history.replaceState(null, '', '/#/fillups');
    await openApp();
    expect(current()).toBe('Fill-ups');
  });

  test('Back returns to the previous tab rather than leaving the app', async () => {
    const user = userEvent.setup();
    await openApp();
    await user.click(screen.getByRole('button', { name: 'Vehicles' }));
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await back();
    await waitFor(() => expect(current()).toBe('Vehicles'));
    expect(window.location.hash).toBe('#/vehicles');
  });

  test('a hash changed while open — a typed address, a link — switches tab', async () => {
    await openApp();
    await act(async () => {
      window.location.hash = '#/vehicles';
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    await waitFor(() => expect(current()).toBe('Vehicles'));
  });

  test('choosing the tab already shown adds no history entry', async () => {
    const user = userEvent.setup();
    await openApp();
    const before = window.history.length;
    await user.click(screen.getByRole('button', { name: 'Dashboard' }));
    expect(window.history.length).toBe(before);
  });
});

describe('an address that names no tab', () => {
  test('opens the default and corrects the address without a history entry', async () => {
    window.history.replaceState(null, '', '/#/nonsense');
    const before = window.history.length;
    await openApp();
    expect(current()).toBe('Dashboard');
    expect(window.location.hash).toBe('#/dashboard');
    expect(window.history.length).toBe(before);
  });

  test('no hash at all opens the requested initial tab', async () => {
    render(<App store={makeStore()} initialTab="settings" />);
    await screen.findByRole('navigation', { name: /sections/i });
    expect(current()).toBe('Settings');
    expect(window.location.hash).toBe('#/settings');
  });

  test('a real hash wins over the initial tab, so a reload is honoured', async () => {
    window.history.replaceState(null, '', '/#/vehicles');
    render(<App store={makeStore()} initialTab="settings" />);
    await screen.findByRole('navigation', { name: /sections/i });
    expect(current()).toBe('Vehicles');
  });
});

describe('parseTab', () => {
  test('reads exactly the four routes', () => {
    expect(parseTab('#/dashboard')).toBe('dashboard');
    expect(parseTab('#/fillups')).toBe('fillups');
    expect(parseTab('#/vehicles')).toBe('vehicles');
    expect(parseTab('#/settings')).toBe('settings');
  });

  test('anything else is no tab at all', () => {
    for (const hash of [
      '',
      '#',
      '#/',
      '#/nonsense',
      '#/SETTINGS',
      '#settings',
      'settings',
      '/settings',
      '#/settings/extra',
      '#/settings?x=1',
      '#/settings ',
      ' #/settings',
      '#//settings',
      '#/__proto__',
      '#/constructor',
      '#/toString',
      '#/%2e%2e',
      '#/../settings',
      `#/${'a'.repeat(100_000)}`,
      `#/settings${'/'.repeat(10_000)}`,
    ]) {
      expect(parseTab(hash), JSON.stringify(hash.slice(0, 40))).toBeNull();
    }
  });
});

describe('link routes (#3)', () => {
  test('a submit or incoming link is a route of its own, carrying its payload', async () => {
    const { parseRoute } = await import('./useTabRoute');
    expect(parseRoute('#/submit/abc_-123')).toEqual({ kind: 'submit', payload: 'abc_-123' });
    expect(parseRoute('#/incoming/XYZ')).toEqual({ kind: 'incoming', payload: 'XYZ' });
    expect(parseRoute('#/settings')).toEqual({ kind: 'tab', tab: 'settings' });
  });

  test.each(['#/submit/', '#/submit', '#/incoming/', '#/submit/a/b', '#submit/abc', '#/SUBMIT/abc', '#/incoming/a/'])(
    '%s is no route',
    async (hash) => {
      const { parseRoute } = await import('./useTabRoute');
      expect(parseRoute(hash)).toBeNull();
    },
  );

  test('opening a link is not "corrected" to the dashboard', async () => {
    window.history.replaceState(null, '', '/#/incoming/not-a-real-payload');
    render(<App store={makeStore()} />);
    await screen.findByRole('heading', { name: 'Fill-up link' });
    expect(window.location.hash).toBe('#/incoming/not-a-real-payload');
  });
});
