// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StubAuthProvider, type AuthUser } from '../data/auth';
import { InMemoryRepository } from '../data/repository';
import type { FillUpRecord, PendingFillUpRecord, VehicleRecord } from '../data/records';
import { FuelTrackerStore } from '../data/store';
import { InMemorySharingWorld } from '../data/sharing';
import type { SharingSync } from '../data/shareSync';
import { InMemoryShareLedger, InMemorySyncState } from '../data/syncState';
import { makeFuelEntryDraft } from '../domain/fuelEntryDraft';
import { App } from './App';
import { saveHasOnboarded } from './onboarding';

/**
 * Sharing a car (#66) as two people meet it: the owner shares from the
 * Vehicles screen, the partner accepts from the banner, both see the car and
 * who logged what, and either can end it.
 */

const KYLE: AuthUser = { uid: 'kyle', email: 'kyle@example.com', displayName: 'Kyle', emailVerified: true };
const SAM: AuthUser = { uid: 'sam', email: 'sam@example.com', displayName: 'Sam', emailVerified: true };
const WAIT = { timeout: 5000 };

function makeStore(author: string): FuelTrackerStore {
  return new FuelTrackerStore(
    {
      vehicles: new InMemoryRepository<VehicleRecord>(),
      fillUps: new InMemoryRepository<FillUpRecord>(),
      pendingFillUps: new InMemoryRepository<PendingFillUpRecord>(),
    },
    undefined,
    author,
  );
}

function sharingFor(world: InMemorySharingWorld, user: AuthUser): SharingSync {
  const states = new Map<string, InMemorySyncState>();
  return {
    remote: world.sharingFor({ uid: user.uid, name: user.displayName, email: user.email, emailVerified: user.emailVerified === true }),
    stateFor: (key) => {
      const state = states.get(key) ?? new InMemorySyncState();
      states.set(key, state);
      return state;
    },
    forgetState: async (key) => {
      states.delete(key);
    },
    ledger: new InMemoryShareLedger(),
  };
}

interface Person {
  readonly user: AuthUser;
  readonly store: FuelTrackerStore;
  readonly sharing: SharingSync;
}

function person(world: InMemorySharingWorld, user: AuthUser): Person {
  saveHasOnboarded(user.uid);
  return { user, store: makeStore(user.uid), sharing: sharingFor(world, user) };
}

function open(world: InMemorySharingWorld, who: Person, initialTab: 'vehicles' | 'fillups' | 'dashboard' = 'vehicles'): void {
  render(
    <App
      store={who.store}
      auth={new StubAuthProvider({ status: 'signedIn', user: who.user })}
      remote={world.remoteFor(who.user.uid)}
      sharing={who.sharing}
      initialTab={initialTab}
    />,
  );
}

async function kylesCivic(world: InMemorySharingWorld, kyle: Person): Promise<VehicleRecord> {
  const car = await kyle.store.addVehicle({ name: 'Civic' });
  const draft = makeFuelEntryDraft({ date: new Date(2026, 0, 1), odometer: 10_000, gallons: 10, pricePerGallon: 3.5 });
  if (draft === null) throw new Error('fixture draft failed validation');
  await kyle.store.addFillUp(draft, car.id);
  // Push it to Kyle's account, so Sam has something to receive.
  await world.remoteFor(KYLE.uid).push(await kyle.store.exportSnapshot());
  return car;
}

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

afterEach(cleanup);

describe('sharing a car', () => {
  test('the owner invites from the Vehicles screen, and is told what it exposes', async () => {
    const world = new InMemorySharingWorld();
    const kyle = person(world, KYLE);
    await kylesCivic(world, kyle);
    const user = userEvent.setup();
    open(world, kyle);

    await user.click(await screen.findByRole('button', { name: 'Share' }));
    expect(screen.getByText(/receipt photos, notes and stations/i)).toBeInTheDocument();
    expect(screen.getByText(/see nothing else of yours/i)).toBeInTheDocument();
    await user.type(screen.getByLabelText(/their google email/i), 'Sam@Example.com');
    await user.click(screen.getByRole('button', { name: 'Invite' }));

    expect(await screen.findByRole('status')).toHaveTextContent(/invited sam@example.com/i);
    expect(await screen.findByText(/waiting for them to accept/i)).toBeInTheDocument();
    expect([...world.invites.values()].map((i) => i.email)).toEqual(['sam@example.com']);
  });

  test('an address that is not one is refused before anything is sent', async () => {
    const world = new InMemorySharingWorld();
    const kyle = person(world, KYLE);
    await kylesCivic(world, kyle);
    const user = userEvent.setup();
    open(world, kyle);
    await user.click(await screen.findByRole('button', { name: 'Share' }));
    await user.type(screen.getByLabelText(/their google email/i), 'sam at example');
    await user.click(screen.getByRole('button', { name: 'Invite' }));
    expect(await screen.findByText(/does not look like an email address/i)).toBeInTheDocument();
    expect(world.invites.size).toBe(0);
  });

  test('the partner accepts from the banner, and the car arrives with its history', async () => {
    const world = new InMemorySharingWorld();
    const kyle = person(world, KYLE);
    const sam = person(world, SAM);
    const car = await kylesCivic(world, kyle);
    await world.sharingFor({ uid: KYLE.uid, name: 'Kyle', email: KYLE.email, emailVerified: true }).invite(car, SAM.email);
    const user = userEvent.setup();
    open(world, sam);

    const banner = await screen.findByRole('region', { name: /invitations/i }, WAIT);
    expect(within(banner).getByText(/kyle/i)).toBeInTheDocument();
    await user.click(within(banner).getByRole('button', { name: /accept civic/i }));

    expect(await screen.findByText(/shared with you by kyle/i, {}, WAIT)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /invitations/i })).not.toBeInTheDocument();
    await waitFor(async () => expect(await sam.store.fillUps(car.id)).toHaveLength(1), WAIT);
    // Never copied into Sam's own account.
    expect((await world.remoteFor(SAM.uid).pull(null)).vehicles).toHaveLength(0);
  });

  test('a shared car offers Leave, not Delete or Share — it is the owner’s', async () => {
    const world = new InMemorySharingWorld();
    const kyle = person(world, KYLE);
    const sam = person(world, SAM);
    const car = await kylesCivic(world, kyle);
    const invite = await world.sharingFor({ uid: KYLE.uid, name: 'Kyle', email: KYLE.email, emailVerified: true }).invite(car, SAM.email);
    await sam.sharing.remote.accept(invite);
    open(world, sam);

    await screen.findByText(/shared with you by kyle/i, {}, WAIT);
    expect(screen.getByRole('button', { name: 'Leave' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Share' })).not.toBeInTheDocument();
  });

  test('declining answers it without joining', async () => {
    const world = new InMemorySharingWorld();
    const kyle = person(world, KYLE);
    const sam = person(world, SAM);
    const car = await kylesCivic(world, kyle);
    await world.sharingFor({ uid: KYLE.uid, name: 'Kyle', email: KYLE.email, emailVerified: true }).invite(car, SAM.email);
    const user = userEvent.setup();
    open(world, sam);
    const banner = await screen.findByRole('region', { name: /invitations/i }, WAIT);
    await user.click(within(banner).getByRole('button', { name: /decline/i }));
    await waitFor(() => expect(screen.queryByRole('region', { name: /invitations/i })).not.toBeInTheDocument(), WAIT);
    expect(world.invites.size).toBe(0);
    expect(world.isMember(KYLE.uid, car.id, SAM.uid)).toBe(false);
  });

  test('an unverified address is never offered an invitation', async () => {
    const world = new InMemorySharingWorld();
    const kyle = person(world, KYLE);
    const car = await kylesCivic(world, kyle);
    await world.sharingFor({ uid: KYLE.uid, name: 'Kyle', email: KYLE.email, emailVerified: true }).invite(car, SAM.email);
    const unverified = person(world, { ...SAM, emailVerified: false });
    open(world, unverified);
    await screen.findByRole('navigation', { name: /sections/i });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.queryByRole('region', { name: /invitations/i })).not.toBeInTheDocument();
  });
});

describe('who logged what', () => {
  test('on a shared car each fill-up says who entered it', async () => {
    const world = new InMemorySharingWorld();
    const kyle = person(world, KYLE);
    const sam = person(world, SAM);
    const car = await kylesCivic(world, kyle);
    const invite = await world.sharingFor({ uid: KYLE.uid, name: 'Kyle', email: KYLE.email, emailVerified: true }).invite(car, SAM.email);
    await sam.sharing.remote.accept(invite);
    open(world, sam, 'fillups');

    expect(await screen.findByText(/entered by kyle/i, {}, WAIT)).toBeInTheDocument();
  });

  test('on a car nobody shares, rows do not say "entered by you"', async () => {
    const world = new InMemorySharingWorld();
    const kyle = person(world, KYLE);
    await kylesCivic(world, kyle);
    open(world, kyle, 'fillups');
    await screen.findByText(/10,000|10000/, {}, WAIT);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.queryByText(/entered by/i)).not.toBeInTheDocument();
  });
});

describe('ending it', () => {
  test('the owner sees who has the car, and can remove them', async () => {
    const world = new InMemorySharingWorld();
    const kyle = person(world, KYLE);
    const sam = person(world, SAM);
    const car = await kylesCivic(world, kyle);
    const invite = await world.sharingFor({ uid: KYLE.uid, name: 'Kyle', email: KYLE.email, emailVerified: true }).invite(car, SAM.email);
    await sam.sharing.remote.accept(invite);
    const user = userEvent.setup();
    open(world, kyle);

    await user.click(await screen.findByRole('button', { name: 'Share' }));
    expect(await screen.findByText(/shared with/i, { selector: 'span' })).toHaveTextContent('Sam');
    await user.click(screen.getByRole('button', { name: /remove sam/i }));
    expect(await screen.findByText(/sam no longer has civic/i)).toBeInTheDocument();
    expect(world.isMember(KYLE.uid, car.id, SAM.uid)).toBe(false);
  });

  test('the partner leaves, and the car is gone from their device — and only theirs', async () => {
    const world = new InMemorySharingWorld();
    const kyle = person(world, KYLE);
    const sam = person(world, SAM);
    const car = await kylesCivic(world, kyle);
    const invite = await world.sharingFor({ uid: KYLE.uid, name: 'Kyle', email: KYLE.email, emailVerified: true }).invite(car, SAM.email);
    await sam.sharing.remote.accept(invite);
    const user = userEvent.setup();
    open(world, sam);

    await user.click(await screen.findByRole('button', { name: 'Leave' }, WAIT));
    expect(screen.getByText(/fill-ups you logged stay with kyle/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /leave civic/i }));

    await waitFor(async () => expect(await sam.store.vehicles()).toHaveLength(0), WAIT);
    expect(await screen.findByText(/no vehicles yet/i, {}, WAIT)).toBeInTheDocument();
    expect((await world.remoteFor(KYLE.uid).pull(null)).vehicles).toHaveLength(1);
  });
});
