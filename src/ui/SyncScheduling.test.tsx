// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InMemoryRepository } from '../data/repository';
import type { FillUpRecord, PendingFillUpRecord, VehicleRecord } from '../data/records';
import { InMemoryRemoteStore } from '../data/remote';
import { FuelTrackerStore } from '../data/store';
import { StubAuthProvider } from '../data/auth';
import { App } from './App';
import { saveHasOnboarded } from './onboarding';
import { SAVE_SYNC_DELAY_MS } from './syncScheduler';

/** Sync timing as the app actually wires it (#52). */
beforeEach(() => localStorage.clear());
afterEach(cleanup);

function signedIn(): StubAuthProvider {
  return new StubAuthProvider({ status: 'signedIn', user: { uid: 'u1', email: 'a@example.com', displayName: 'A' } });
}

function makeStore(): FuelTrackerStore {
  return new FuelTrackerStore({
    vehicles: new InMemoryRepository<VehicleRecord>(),
    fillUps: new InMemoryRepository<FillUpRecord>(),
    pendingFillUps: new InMemoryRepository<PendingFillUpRecord>(),
  });
}

test('a new vehicle reaches the account without the window losing and regaining focus', async () => {
  saveHasOnboarded('u1');
  const remote = new InMemoryRemoteStore();
  const user = userEvent.setup();
  render(<App store={makeStore()} auth={signedIn()} remote={remote} initialTab="vehicles" />);

  await user.type(await screen.findByLabelText('Name'), 'Daily Driver');
  await user.click(screen.getByRole('button', { name: /add vehicle/i }));

  await waitFor(async () => expect((await remote.pull()).vehicles).toHaveLength(1), {
    timeout: SAVE_SYNC_DELAY_MS + 3000,
  });
});

test('focusing the window again straight away does not re-read the account', async () => {
  saveHasOnboarded('u1');
  const remote = new InMemoryRemoteStore();
  render(<App store={makeStore()} auth={signedIn()} remote={remote} />);
  await waitFor(() => expect(remote.pullLog).toHaveLength(1));

  act(() => {
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('focus'));
  });
  await new Promise((resolve) => setTimeout(resolve, 50));

  expect(remote.pullLog).toHaveLength(1);
});
