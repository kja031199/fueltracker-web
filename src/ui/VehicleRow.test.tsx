// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StubAuthProvider, type AuthUser } from '../data/auth';
import { InMemoryRepository } from '../data/repository';
import type { FillUpRecord, PendingFillUpRecord, VehicleRecord } from '../data/records';
import { FuelTrackerStore } from '../data/store';
import { InMemorySharingWorld } from '../data/sharing';
import type { SharingSync } from '../data/shareSync';
import { InMemorySyncState } from '../data/syncState';
import { InMemoryShareLedger } from '../data/shareLedger';
import { App } from './App';
import { saveHasOnboarded } from './onboarding';

/**
 * A car's row does one thing at a time (#93). The screen kept four ids — which
 * car was sharing, requesting, leaving, confirming — so one row could show its
 * sharing panel and its request link together, and which buttons showed was
 * spread across four comparisons. Each row now has one mode.
 */

const ME: AuthUser = { uid: 'me', email: 'me@example.com', displayName: 'Me', emailVerified: true };

function sharingFor(world: InMemorySharingWorld): SharingSync {
  return {
    remote: world.sharingFor({ uid: ME.uid, name: ME.displayName, email: ME.email, emailVerified: true }),
    stateFor: () => new InMemorySyncState(),
    forgetState: async () => {},
    ledger: new InMemoryShareLedger(),
  };
}

async function openWith(names: readonly string[]): Promise<void> {
  const store = new FuelTrackerStore({
    vehicles: new InMemoryRepository<VehicleRecord>(),
    fillUps: new InMemoryRepository<FillUpRecord>(),
    pendingFillUps: new InMemoryRepository<PendingFillUpRecord>(),
  });
  for (const name of names) await store.addVehicle({ name });
  saveHasOnboarded(ME.uid);
  const world = new InMemorySharingWorld();
  render(
    <App
      store={store}
      auth={new StubAuthProvider({ status: 'signedIn', user: ME })}
      remote={world.remoteFor(ME.uid)}
      sharing={sharingFor(world)}
      initialTab="vehicles"
    />,
  );
  await screen.findAllByRole('button', { name: /^Request a fill-up for / });
}

/** The row for a car, by its name. */
function row(name: string): HTMLElement {
  const item = screen.getAllByRole('listitem').find((li) => within(li).queryByText(name, { selector: 'strong' }));
  if (item === undefined) throw new Error(`no row for ${name}`);
  return item;
}

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe('a car’s row does one thing at a time', () => {
  test('opening the request link closes the sharing panel', async () => {
    const user = userEvent.setup();
    await openWith(['Civic']);
    const civic = (): ReturnType<typeof within> => within(row('Civic'));

    await user.click(civic().getByRole('button', { name: /^Share / }));
    expect(civic().getByRole('button', { name: /^Done sharing / })).toHaveAttribute('aria-expanded', 'true');
    expect(civic().getByText(/Someone you share Civic with/)).toBeInTheDocument();

    await user.click(civic().getByRole('button', { name: /^Request a fill-up for / }));
    expect(civic().getByRole('button', { name: /^Done with the request link/ })).toHaveAttribute('aria-expanded', 'true');
    expect(civic().getByRole('button', { name: /^Share / })).toHaveAttribute('aria-expanded', 'false');
    expect(civic().queryByRole('button', { name: /^Done sharing / })).toBeNull();
    expect(civic().queryByText(/Someone you share Civic with/)).toBeNull();
  });

  test('pressing an open panel’s button again closes it', async () => {
    const user = userEvent.setup();
    await openWith(['Civic']);
    const civic = within(row('Civic'));
    await user.click(civic.getByRole('button', { name: /^Request a fill-up for / }));
    await user.click(civic.getByRole('button', { name: /^Done with the request link/ }));
    expect(civic.getByRole('button', { name: /^Request a fill-up for / })).toHaveAttribute('aria-expanded', 'false');
  });

  test('asking to delete hides the other actions, and Keep brings them back', async () => {
    const user = userEvent.setup();
    await openWith(['Civic']);
    const civic = within(row('Civic'));

    await user.click(civic.getByRole('button', { name: /^Delete (?!the fill-up)/ }));
    expect(civic.getByRole('button', { name: /Delete Civic and its fill-ups/ })).toBeInTheDocument();
    expect(civic.queryByRole('button', { name: /^Request a fill-up for / })).toBeNull();

    await user.click(civic.getByRole('button', { name: 'Keep' }));
    expect(civic.getByRole('button', { name: /^Request a fill-up for / })).toBeInTheDocument();
    expect(civic.getByRole('button', { name: /^Delete (?!the fill-up)/ })).toBeInTheDocument();
  });

  test('each car keeps its own mode', async () => {
    const user = userEvent.setup();
    await openWith(['Civic', 'Golf']);
    await user.click(within(row('Civic')).getByRole('button', { name: /^Share / }));
    await user.click(within(row('Golf')).getByRole('button', { name: /^Request a fill-up for / }));
    expect(within(row('Civic')).getByRole('button', { name: /^Done sharing / })).toBeInTheDocument();
    expect(within(row('Golf')).getByRole('button', { name: /^Done with the request link/ })).toBeInTheDocument();
  });
});
