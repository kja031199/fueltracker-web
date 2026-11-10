import { beforeEach, expect, test } from 'vitest';
import { makeStore } from '../test/fixtures';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InMemoryRemoteStore } from '../data/remote';
import { StubAuthProvider } from '../data/auth';
import { App } from './App';
import { saveHasOnboarded } from './onboarding';
import { manualTimers } from '../test/manualTimers';

/** Sync timing as the app actually wires it (#52). */
beforeEach(() => localStorage.clear());

function signedIn(): StubAuthProvider {
  return new StubAuthProvider({ status: 'signedIn', user: { uid: 'u1', email: 'a@example.com', displayName: 'A' } });
}

test('a new vehicle reaches the account without the window losing and regaining focus', async () => {
  saveHasOnboarded('u1');
  const remote = new InMemoryRemoteStore();
  const timers = manualTimers();
  const user = userEvent.setup();
  render(<App store={makeStore()} auth={signedIn()} remote={remote} initialTab="vehicles" syncTimers={timers} />);

  await user.type(await screen.findByLabelText('Name'), 'Daily Driver');
  await user.click(screen.getByRole('button', { name: /add vehicle/i }));

  // The save scheduled its sync: run it now rather than wait 1.5 s (#97).
  await waitFor(() => expect(timers.pending()).toBe(1));
  await act(async () => {
    timers.fire();
  });
  await waitFor(async () => expect((await remote.pull()).vehicles).toHaveLength(1));
});

test('focusing the window again straight away does not re-read the account', async () => {
  saveHasOnboarded('u1');
  const remote = new InMemoryRemoteStore();
  const user = userEvent.setup();
  render(<App store={makeStore()} auth={signedIn()} remote={remote} initialTab="settings" />);
  await waitFor(() => expect(remote.pullLog).toHaveLength(1));
  await screen.findByRole('button', { name: 'Sync now' });

  act(() => {
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('focus'));
  });

  // A positive control, not a sleep (#97): one sync on purpose, and then
  // exactly two reads of the account. A sync started by either focus would
  // make it three — before this one, or queued behind it.
  await user.click(screen.getByRole('button', { name: 'Sync now' }));
  await waitFor(() => expect(remote.pullLog.length).toBeGreaterThanOrEqual(2));
  await screen.findByRole('button', { name: 'Sync now' });
  expect(remote.pullLog).toHaveLength(2);
});
