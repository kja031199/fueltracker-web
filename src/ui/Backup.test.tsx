// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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

/** Captures what the page tried to hand the reader, instead of downloading it. */
function captureDownloads(): { name: string; text: string }[] {
  const captured: { name: string; text: string }[] = [];
  const blobs = new Map<string, Blob>();
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: (blob: Blob) => {
      const url = `blob:${blobs.size}`;
      blobs.set(url, blob);
      return url;
    },
    revokeObjectURL: () => {},
  });
  const click = HTMLAnchorElement.prototype.click;
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    const blob = blobs.get(this.href);
    if (blob !== undefined) {
      // Blob.text() is async; the tests await the captured entry instead.
      void blob.text().then((text) => captured.push({ name: this.download, text }));
    }
  });
  void click;
  return captured;
}

async function renderSettings(store: FuelTrackerStore): Promise<void> {
  localStorage.setItem('fueltracker.hasOnboarded', 'true');
  render(<App store={store} initialTab="settings" />);
  await screen.findByRole('heading', { name: /backup and restore/i });
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('exporting', () => {
  test('offers a complete JSON backup and says what is in it', async () => {
    const user = userEvent.setup();
    const captured = captureDownloads();
    const store = makeStore();
    const vehicle = await store.addVehicle({ name: 'Daily Driver' });
    await store.addFillUp(draft(), vehicle.id);
    await renderSettings(store);

    await user.click(screen.getByRole('button', { name: /export backup \(json\)/i }));

    expect(await screen.findByRole('status')).toHaveTextContent(/1 vehicle\(s\) and 1 fill-up\(s\)/);
    await waitFor(() => expect(captured).toHaveLength(1));
    expect(captured[0]!.name).toMatch(/^fueltracker-\d{4}-\d{2}-\d{2}\.json$/);
    expect(captured[0]!.text).toContain('fueltracker-backup');
  });

  test('the CSV leaves deleted fill-ups out', async () => {
    // A tombstone is a backup concern, not a spreadsheet one — nobody wants a
    // deleted fill-up in their expense report.
    const user = userEvent.setup();
    const captured = captureDownloads();
    const store = makeStore();
    const vehicle = await store.addVehicle({ name: 'Car' });
    await store.addFillUp(draft({ station: 'Shell' }), vehicle.id);
    const gone = await store.addFillUp(draft({ odometer: 10_400, station: 'Costco' }), vehicle.id);
    await store.removeFillUp(gone.id);
    await renderSettings(store);

    await user.click(screen.getByRole('button', { name: /export spreadsheet \(csv\)/i }));
    await waitFor(() => expect(captured).toHaveLength(1));
    expect(captured[0]!.name).toMatch(/\.csv$/);
    expect(captured[0]!.text).toContain('Shell');
    expect(captured[0]!.text).not.toContain('Costco');
  });
});

describe('importing', () => {
  async function importFile(user: ReturnType<typeof userEvent.setup>, file: File): Promise<void> {
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    if (input === null) throw new Error('no file input');
    await user.upload(input, file);
  }

  test('restores a backup into an empty app', async () => {
    const user = userEvent.setup();
    const captured = captureDownloads();

    // Take a real backup from one store...
    const source = makeStore();
    const vehicle = await source.addVehicle({ name: 'Daily Driver' });
    await source.addFillUp(draft(), vehicle.id);
    await renderSettings(source);
    await user.click(screen.getByRole('button', { name: /export backup \(json\)/i }));
    await waitFor(() => expect(captured).toHaveLength(1));
    cleanup();

    // ...and restore it into a brand-new one, the cleared-browser case.
    const target = makeStore();
    await renderSettings(target);
    await importFile(
      user,
      new File([captured[0]!.text], 'fueltracker-2025-01-01.json', { type: 'application/json' }),
    );

    await waitFor(async () => expect(await target.vehicles()).toHaveLength(1));
    const restored = await target.vehicles();
    expect(await target.fillUps(restored[0]!.id)).toHaveLength(1);
    expect(await screen.findByRole('status')).toHaveTextContent(/imported 1 fill-up\(s\)/i);
  });

  test('a file that is not a backup is refused with a reason', async () => {
    const user = userEvent.setup();
    const store = makeStore();
    await renderSettings(store);

    await importFile(user, new File(['{ truncated'], 'notes.json', { type: 'application/json' }));
    expect(await screen.findByText(/not valid JSON/i)).toBeInTheDocument();
    expect(await store.vehicles()).toHaveLength(0);
  });

  test('reports the rows it could not import instead of failing silently', async () => {
    const user = userEvent.setup();
    const store = makeStore();
    await renderSettings(store);

    const csv =
      'id,vehicle_id,date_iso,odometer_miles,gallons,price_per_gallon\n' +
      'f1,v1,2025-01-15T00:00:00Z,10000,10,3.5\n' +
      'f2,v1,2025-01-20T00:00:00Z,10400,0,3.5\n';
    await importFile(user, new File([csv], 'export.csv', { type: 'text/csv' }));

    expect(await screen.findByText(/1 row\(s\) could not be imported/i)).toBeInTheDocument();
    expect(screen.getByText(/positive numbers/i)).toBeInTheDocument();
    // ...and the good row still landed.
    await waitFor(async () => expect(await store.fillUps('v1')).toHaveLength(1));
  });
});

describe('the storage warning', () => {
  test('now points at export rather than admitting there is none', async () => {
    await renderSettings(makeStore());
    expect(screen.getByText(/export a backup now and again/i)).toBeInTheDocument();
  });
});
