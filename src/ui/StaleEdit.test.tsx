import { beforeEach, describe, expect, test } from 'vitest';
import { draftWith, makeStore, saveHasOnboarded } from '../test/fixtures';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';
import { FillUpForm } from './FillUpForm';
import { FuelLogProvider } from './fuelLog';

const draft = draftWith({ date: new Date(2025, 0, 15), station: 'Shell' });

/**
 * #83. The edit form can stay open while a sync changes the log under it. It
 * used to save under whichever car was *selected* — after such a sync, a
 * different car — so the fill-up moved silently; and a fill-up deleted
 * meanwhile was written back as a new row.
 */

beforeEach(() => {
  localStorage.clear();
  saveHasOnboarded('local');
});

describe('saving an edit after the log changed underneath it (#83)', () => {
  test('a fill-up stays on its own car when another car is the one selected', async () => {
    const store = makeStore();
    const a = await store.addVehicle({ name: 'A' });
    const b = await store.addVehicle({ name: 'B' });
    const created = await store.addFillUp(draft(), a.id);
    const editing = await store.fillUp(created.id);
    if (editing === undefined) throw new Error('no fill-up');
    let saved = false;
    const user = userEvent.setup();
    // The selection moved to B while the form for A's fill-up was open.
    render(
      <FuelLogProvider store={store} remote={null} uid="local">
        <FillUpForm
          vehicleId={b.id}
          existing={[]}
          editing={editing}
          onSaved={async () => {
            saved = true;
          }}
          onCancel={() => {}}
        />
      </FuelLogProvider>,
    );

    const station = screen.getByLabelText(/gas station/i);
    await user.clear(station);
    await user.type(station, 'Costco');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(saved).toBe(true));
    expect((await store.fillUps(a.id)).map((row) => row.station)).toEqual(['Costco']);
    expect(await store.fillUps(b.id)).toHaveLength(0);
  });

  test('a fill-up deleted while it was being edited is not brought back, and the form says why', async () => {
    const store = makeStore();
    const car = await store.addVehicle({ name: 'Daily Driver' });
    const created = await store.addFillUp(draft(), car.id);
    const user = userEvent.setup();
    render(<App store={store} initialTab="fillups" />);

    await user.click(await screen.findByRole('button', { name: /^edit the fill-up of /i }));
    const station = screen.getByLabelText(/gas station/i);
    await user.clear(station);
    await user.type(station, 'Costco');
    // Deleted elsewhere and synced, while the form is open.
    await store.removeFillUp(created.id);
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/deleted while you were editing/i);
    // The form stays, with what was typed, so nothing is silently lost.
    expect(screen.getByLabelText(/gas station/i)).toHaveValue('Costco');
    expect(await store.fillUpCount()).toBe(0);
    expect(await store.fillUp(created.id)).toBeUndefined();
  });

  test('Cancel after the refusal returns to the list, which no longer shows it', async () => {
    const store = makeStore();
    const car = await store.addVehicle({ name: 'Daily Driver' });
    const created = await store.addFillUp(draft(), car.id);
    const user = userEvent.setup();
    render(<App store={store} initialTab="fillups" />);

    await user.click(await screen.findByRole('button', { name: /^edit the fill-up of /i }));
    await store.removeFillUp(created.id);
    await user.click(screen.getByRole('button', { name: /save changes/i }));
    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(await screen.findByText(/no fill-ups yet/i)).toBeInTheDocument();
  });
});
