// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InMemoryRepository } from '../data/repository';
import type { FillUpRecord, PendingFillUpRecord, VehicleRecord } from '../data/records';
import { FuelTrackerStore } from '../data/store';
import { makeFuelEntryDraft } from '../domain/fuelEntryDraft';
import { MINIMUM_ENTRIES_TO_PROMPT, SNOOZE_DAYS } from '../domain/exportReminder';
import { loadBackupState } from './backupNudge';
import { App } from './App';

/**
 * The reminder as a reader meets it.
 *
 * The decision itself is covered exhaustively in
 * `domain/exportReminder.test.ts`; this file is about whether the banner shows
 * up, whether taking a backup clears it, and — the one that matters — whether
 * dismissing it merely snoozes.
 */

async function storeWith(fillUps: number): Promise<FuelTrackerStore> {
  const store = new FuelTrackerStore({
    vehicles: new InMemoryRepository<VehicleRecord>(),
    fillUps: new InMemoryRepository<FillUpRecord>(),
    pendingFillUps: new InMemoryRepository<PendingFillUpRecord>(),
  });
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

beforeEach(() => {
  localStorage.clear();
  // jsdom has no download machinery; the export path calls createObjectURL.
  Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:x'), writable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), writable: true });
});

afterEach(cleanup);

describe('the backup reminder', () => {
  test('is not shown to someone with barely any data', async () => {
    // Nagging a brand-new reader is how you train someone to ignore the
    // banner that matters later.
    render(<App store={await storeWith(MINIMUM_ENTRIES_TO_PROMPT - 1)} />);
    await screen.findByRole('navigation', { name: /sections/i });
    expect(screen.queryByRole('button', { name: /save a backup/i })).not.toBeInTheDocument();
  });

  test('tells someone who has never backed up, and says why it matters', async () => {
    render(<App store={await storeWith(MINIMUM_ENTRIES_TO_PROMPT)} />);
    expect(await screen.findByText(/never saved a backup/i)).toBeInTheDocument();
    expect(screen.getByText(/does not depend on your Google account/i)).toBeInTheDocument();
  });

  test('taking a backup clears it', async () => {
    const user = userEvent.setup();
    render(<App store={await storeWith(MINIMUM_ENTRIES_TO_PROMPT)} />);

    await user.click(await screen.findByRole('button', { name: /save a backup/i }));

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /save a backup/i })).not.toBeInTheDocument(),
    );
    expect(loadBackupState().lastExportAt).not.toBeNull();
  });

  test('dismissing snoozes rather than silencing', async () => {
    // The point of the whole feature. A permanent dismissal would quietly
    // re-open the risk it exists to close, so the stored state has to carry an
    // expiry rather than an off switch.
    const user = userEvent.setup();
    render(<App store={await storeWith(MINIMUM_ENTRIES_TO_PROMPT)} />);

    await user.click(await screen.findByRole('button', { name: /not now/i }));

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /save a backup/i })).not.toBeInTheDocument(),
    );

    const stored = loadBackupState();
    expect(stored.snoozedUntil).not.toBeNull();
    expect(stored.lastExportAt).toBeNull();

    const week = SNOOZE_DAYS * 24 * 60 * 60 * 1000;
    expect(stored.snoozedUntil!).toBeGreaterThan(Date.now());
    expect(stored.snoozedUntil!).toBeLessThanOrEqual(Date.now() + week);
  });

  test('survives storage that cannot be read', async () => {
    // Private mode with storage blocked. Erring toward prompting is correct:
    // the alternative is silence about the only recovery path there is.
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      render(<App store={await storeWith(MINIMUM_ENTRIES_TO_PROMPT)} />);
      expect(await screen.findByText(/never saved a backup/i)).toBeInTheDocument();
    } finally {
      getItem.mockRestore();
    }
  });

  test('treats a hand-edited stored value as no backup at all', async () => {
    localStorage.setItem('fueltracker.lastBackup', '{"lastExportAt":"recently"}');
    render(<App store={await storeWith(MINIMUM_ENTRIES_TO_PROMPT)} />);
    expect(await screen.findByText(/never saved a backup/i)).toBeInTheDocument();
  });

  test('counts fill-ups across every vehicle, not just the selected one', async () => {
    // Three cars with two fill-ups each is six worth losing. Counting only the
    // selected vehicle would keep this reader under the threshold forever.
    const store = new FuelTrackerStore({
      vehicles: new InMemoryRepository<VehicleRecord>(),
      fillUps: new InMemoryRepository<FillUpRecord>(),
      pendingFillUps: new InMemoryRepository<PendingFillUpRecord>(),
    });
    for (const name of ['Civic', 'Truck', 'Van']) {
      const vehicle = await store.addVehicle({ name });
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
    }

    render(<App store={store} />);
    expect(await screen.findByText(/never saved a backup/i)).toBeInTheDocument();
  });
});

describe('Settings', () => {
  test('says when the last backup was', async () => {
    render(<App store={await storeWith(2)} initialTab="settings" />);
    expect(await screen.findByText(/last backup:/i)).toBeInTheDocument();
    expect(screen.getByText(/not yet/i)).toBeInTheDocument();
  });

  test('is explicit that the CSV is not a backup', async () => {
    // Someone who exports a CSV and believes they are covered would find, on
    // restoring, that their deletions and their second car were never in it.
    render(<App store={await storeWith(2)} initialTab="settings" />);
    expect(await screen.findByText(/only the JSON export counts as a backup/i)).toBeInTheDocument();
  });

  test('a CSV export does not count as having backed up', async () => {
    const user = userEvent.setup();
    render(<App store={await storeWith(MINIMUM_ENTRIES_TO_PROMPT)} initialTab="settings" />);

    await user.click(await screen.findByRole('button', { name: /export spreadsheet/i }));
    await screen.findByText(/Saved \d+ fill-up\(s\) as CSV/i);

    expect(loadBackupState().lastExportAt).toBeNull();
    expect(screen.getByRole('button', { name: /save a backup/i })).toBeInTheDocument();
  });

  test('a JSON export from Settings does count', async () => {
    const user = userEvent.setup();
    render(<App store={await storeWith(MINIMUM_ENTRIES_TO_PROMPT)} initialTab="settings" />);

    await user.click(await screen.findByRole('button', { name: /export backup \(JSON\)/i }));
    await screen.findByText(/Saved a backup of/i);

    expect(loadBackupState().lastExportAt).not.toBeNull();
  });
});
