import { beforeEach, describe, expect, test } from 'vitest';
import { makeStore, saveHasOnboarded, sharingFor } from '../test/fixtures';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StubAuthProvider, type AuthUser } from '../data/auth';
import type { VehicleRecord } from '../data/records';
import { FuelTrackerStore } from '../data/store';
import { InMemorySharingWorld } from '../data/testing/inMemorySharing';
import type { SharingSync } from '../data/shareSync';
import { makeFuelEntryDraft } from '../domain/fuelEntryDraft';
import { App } from './App';

/**
 * Sharing a car (#66) as two people meet it: the owner shares from the
 * Vehicles screen, the partner accepts from the banner, both see the car and
 * who logged what, and either can end it.
 */

const KYLE: AuthUser = { uid: 'kyle', email: 'kyle@example.com', displayName: 'Kyle', emailVerified: true };
const SAM: AuthUser = { uid: 'sam', email: 'sam@example.com', displayName: 'Sam', emailVerified: true };
const WAIT = { timeout: 5000 };

interface Person {
  readonly user: AuthUser;
  readonly store: FuelTrackerStore;
  readonly sharing: SharingSync;
}

function person(world: InMemorySharingWorld, user: AuthUser): Person {
  saveHasOnboarded(user.uid);
  return { user, store: makeStore({ author: user.uid }), sharing: sharingFor(world, user) };
}

function open(world: InMemorySharingWorld, who: Person, initialTab: 'vehicles' | 'fillups' | 'dashboard' | 'settings' = 'vehicles'): void {
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

describe('sharing a car', () => {
  test('the owner invites from the Vehicles screen, and is told what it exposes', async () => {
    const world = new InMemorySharingWorld();
    const kyle = person(world, KYLE);
    await kylesCivic(world, kyle);
    const user = userEvent.setup();
    open(world, kyle);

    await user.click(await screen.findByRole('button', { name: /^Share / }));
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
    await user.click(await screen.findByRole('button', { name: /^Share / }));
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
    expect(screen.getByRole('button', { name: /^Leave / })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Delete (?!the fill-up)/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Share / })).not.toBeInTheDocument();
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
    // The invitations have been asked for — the moment one would appear —
    // waited for by the read itself, not by a sleep (#97).
    await waitFor(() => expect(world.reads.invitesForMe).toBeGreaterThan(0), WAIT);
    await act(async () => {});
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

    expect(await screen.findByText(/entered by kyle \(owner\)/i, {}, WAIT)).toBeInTheDocument();
  });

  test('a member who calls themselves the owner is shown with their own verified email (#81)', async () => {
    const world = new InMemorySharingWorld();
    const kyle = person(world, KYLE);
    // Sam's chosen name is the owner's. Only the email is Google's.
    const impostor = person(world, { ...SAM, displayName: 'Kyle' });
    const car = await kylesCivic(world, kyle);
    const invite = await world.sharingFor({ uid: KYLE.uid, name: 'Kyle', email: KYLE.email, emailVerified: true }).invite(car, SAM.email);
    await impostor.sharing.remote.accept(invite);
    // A fill-up the member logged on the shared car, already in the owner's account.
    const [mine] = await kyle.store.fillUps(car.id);
    const whole = mine === undefined ? undefined : await kyle.store.fillUp(mine.id);
    if (whole === undefined) throw new Error('no fill-up');
    await kyle.store.importBackup({
      vehicles: [],
      fillUps: [{ ...whole, id: 'by-sam', odometer: 10_300, enteredBy: SAM.uid, updatedAt: Date.now() }],
      pendingFillUps: [],
    });
    await world.remoteFor(KYLE.uid).push(await kyle.store.exportSnapshot());

    open(world, kyle, 'fillups');
    expect(await screen.findByText(/entered by kyle \(sam@example\.com\)/i, {}, WAIT)).toBeInTheDocument();
    expect(screen.getByText(/entered by you/i)).toBeInTheDocument();
    const said = screen.getAllByText(/^entered by/i).map((line) => line.textContent?.trim());
    expect(said).not.toContain('Entered by Kyle');
    cleanup();
    window.history.replaceState(null, '', '/');

    // On the member's own device, the owner's rows are marked as the owner's.
    open(world, impostor, 'fillups');
    expect(await screen.findByText(/entered by kyle \(owner\)/i, {}, WAIT)).toBeInTheDocument();
    expect(screen.getByText(/entered by you/i)).toBeInTheDocument();
  }, 15_000);

  test('on a car nobody shares, rows do not say "entered by you"', async () => {
    const world = new InMemorySharingWorld();
    const kyle = person(world, KYLE);
    await kylesCivic(world, kyle);
    open(world, kyle, 'fillups');
    await screen.findByText(/10,000|10000/, {}, WAIT);
    // The sync has read who the car is shared with — after which a name
    // would show — waited for by the read, not by a sleep (#97).
    await waitFor(() => expect(world.reads.memberships).toBeGreaterThan(0), WAIT);
    await act(async () => {});
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

    await user.click(await screen.findByRole('button', { name: /^Share / }));
    // Who they are, by the email Google verified, not only the name they chose (#81).
    expect(await screen.findByText(/shared with/i, { selector: 'span' })).toHaveTextContent(/^Shared with Sam \(sam@example\.com\)$/);
    await user.click(screen.getByRole('button', { name: /remove sam \(sam@example\.com\)/i }));
    expect(await screen.findByText(/sam \(sam@example\.com\) no longer has civic/i)).toBeInTheDocument();
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

    await user.click(await screen.findByRole('button', { name: /^Leave / }, WAIT));
    expect(screen.getByText(/fill-ups you logged stay with kyle/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /leave civic/i }));

    await waitFor(async () => expect(await sam.store.vehicles()).toHaveLength(0), WAIT);
    expect(await screen.findByText(/no vehicles yet/i, {}, WAIT)).toBeInTheDocument();
    expect((await world.remoteFor(KYLE.uid).pull(null)).vehicles).toHaveLength(1);
  });
});

// --- Broader cases -------------------------------------------------------------

describe('when sharing is not available', () => {
  test('there is no Share button and no invitations banner', async () => {
    const world = new InMemorySharingWorld();
    const kyle = person(world, KYLE);
    await kylesCivic(world, kyle);
    render(
      <App
        store={kyle.store}
        auth={new StubAuthProvider({ status: 'signedIn', user: KYLE })}
        initialTab="vehicles"
      />,
    );
    await screen.findByText('Civic');
    expect(screen.queryByRole('button', { name: /^Share / })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /invitations/i })).not.toBeInTheDocument();
    // And deleting does not mention people it cannot be shared with.
    await userEvent.setup().click(screen.getByRole('button', { name: /^Delete (?!the fill-up)/ }));
    expect(screen.getByRole('button', { name: /delete civic/i })).not.toHaveTextContent(/shared with/i);
  });
});

describe('the owner’s side, more widely', () => {
  test('withdrawing an invitation removes it', async () => {
    const world = new InMemorySharingWorld();
    const kyle = person(world, KYLE);
    const car = await kylesCivic(world, kyle);
    await kyle.sharing.remote.invite(car, SAM.email);
    const user = userEvent.setup();
    open(world, kyle);
    await user.click(await screen.findByRole('button', { name: /^Share / }));
    await user.click(await screen.findByRole('button', { name: /withdraw sam@example.com/i }));
    expect(await screen.findByRole('status')).toHaveTextContent(/withdrew the invitation/i);
    expect(world.invites.size).toBe(0);
    expect(screen.queryByText(/waiting for them to accept/i)).not.toBeInTheDocument();
  });

  test('inviting the same address twice says what to do', async () => {
    const world = new InMemorySharingWorld();
    const kyle = person(world, KYLE);
    const car = await kylesCivic(world, kyle);
    await kyle.sharing.remote.invite(car, SAM.email);
    const user = userEvent.setup();
    open(world, kyle);
    await user.click(await screen.findByRole('button', { name: /^Share / }));
    await user.type(screen.getByLabelText(/their google email/i), SAM.email);
    await user.click(screen.getByRole('button', { name: 'Invite' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/withdraw it to send a new one/i);
  });

  test('the Invite button waits for an address', async () => {
    const world = new InMemorySharingWorld();
    const kyle = person(world, KYLE);
    await kylesCivic(world, kyle);
    const user = userEvent.setup();
    open(world, kyle);
    await user.click(await screen.findByRole('button', { name: /^Share / }));
    expect(screen.getByRole('button', { name: 'Invite' })).toBeDisabled();
    await user.type(screen.getByLabelText(/their google email/i), '   ');
    expect(screen.getByRole('button', { name: 'Invite' })).toBeDisabled();
  });

  test('if who it is shared with cannot be loaded, it says so', async () => {
    const world = new InMemorySharingWorld();
    const kyle = person(world, KYLE);
    await kylesCivic(world, kyle);
    kyle.sharing.remote.members = () => Promise.reject(new Error('offline'));
    const user = userEvent.setup();
    open(world, kyle);
    await user.click(await screen.findByRole('button', { name: /^Share / }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be loaded/i);
  });

  test('deleting a car warns that it goes for everyone it is shared with', async () => {
    const world = new InMemorySharingWorld();
    const kyle = person(world, KYLE);
    await kylesCivic(world, kyle);
    const user = userEvent.setup();
    open(world, kyle);
    await user.click(await screen.findByRole('button', { name: /^Delete (?!the fill-up)/ }));
    expect(screen.getByRole('button', { name: /delete civic/i })).toHaveTextContent(/for everyone it is shared with/i);
  });

  test('closing the panel hides it', async () => {
    const world = new InMemorySharingWorld();
    const kyle = person(world, KYLE);
    await kylesCivic(world, kyle);
    const user = userEvent.setup();
    open(world, kyle);
    await user.click(await screen.findByRole('button', { name: /^Share / }));
    expect(screen.getByLabelText(/their google email/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Done sharing / }));
    expect(screen.queryByLabelText(/their google email/i)).not.toBeInTheDocument();
  });
});

describe('the partner’s side, more widely', () => {
  test('an accept that fails says so, and the invitation stays to try again', async () => {
    const world = new InMemorySharingWorld();
    const kyle = person(world, KYLE);
    const sam = person(world, SAM);
    const car = await kylesCivic(world, kyle);
    await kyle.sharing.remote.invite(car, SAM.email);
    sam.sharing.remote.accept = () => Promise.reject(new Error('offline'));
    const user = userEvent.setup();
    open(world, sam);
    const banner = await screen.findByRole('region', { name: /invitations/i }, WAIT);
    await user.click(within(banner).getByRole('button', { name: /accept civic/i }));
    expect(await within(banner).findByRole('alert')).toHaveTextContent(/could not be answered/i);
    expect(within(banner).getByRole('button', { name: /accept civic/i })).toBeEnabled();
    expect(world.invites.size).toBe(1);
  });

  test('two invitations are offered separately', async () => {
    const world = new InMemorySharingWorld();
    const kyle = person(world, KYLE);
    const sam = person(world, SAM);
    const civic = await kylesCivic(world, kyle);
    const truck = await kyle.store.addVehicle({ name: 'Truck' });
    await world.remoteFor(KYLE.uid).push(await kyle.store.exportSnapshot());
    await kyle.sharing.remote.invite(civic, SAM.email);
    await kyle.sharing.remote.invite(truck, SAM.email);
    open(world, sam);
    const banner = await screen.findByRole('region', { name: /invitations/i }, WAIT);
    expect(within(banner).getByRole('button', { name: /accept civic/i })).toBeInTheDocument();
    expect(within(banner).getByRole('button', { name: /accept truck/i })).toBeInTheDocument();
  });

  test('choosing Stay keeps the car', async () => {
    const world = new InMemorySharingWorld();
    const kyle = person(world, KYLE);
    const sam = person(world, SAM);
    const car = await kylesCivic(world, kyle);
    await sam.sharing.remote.accept(await kyle.sharing.remote.invite(car, SAM.email));
    const user = userEvent.setup();
    open(world, sam);
    await user.click(await screen.findByRole('button', { name: /^Leave / }, WAIT));
    await user.click(screen.getByRole('button', { name: 'Stay' }));
    expect(screen.getByRole('button', { name: /^Leave / })).toBeInTheDocument();
    expect(world.isMember(KYLE.uid, car.id, SAM.uid)).toBe(true);
  });

  test('the partner can still keep a car of their own, with the usual controls', async () => {
    const world = new InMemorySharingWorld();
    const kyle = person(world, KYLE);
    const sam = person(world, SAM);
    const car = await kylesCivic(world, kyle);
    await sam.sharing.remote.accept(await kyle.sharing.remote.invite(car, SAM.email));
    await sam.store.addVehicle({ name: 'Bike' });
    open(world, sam);
    await screen.findByText(/shared with you by kyle/i, {}, WAIT);
    expect(screen.getAllByRole('button', { name: /^Share / })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /^Delete (?!the fill-up)/ })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /^Leave / })).toHaveLength(1);
  });
});

describe('an invitation to a car whose id is one of yours (#78)', () => {
  /** Sam's own car, synced; Kyle files a car under the same id and invites Sam. */
  async function clashing(world: InMemorySharingWorld, sam: Person): Promise<VehicleRecord> {
    const mine = await sam.store.addVehicle({ name: 'My Civic' });
    const draft = makeFuelEntryDraft({ date: new Date(2026, 0, 1), odometer: 20_000, gallons: 10, pricePerGallon: 3.5 });
    if (draft === null) throw new Error('fixture draft failed validation');
    await sam.store.addFillUp(draft, mine.id);
    await world.remoteFor(KYLE.uid).push({ vehicles: [{ ...mine, name: 'Bait' }], fillUps: [], pendingFillUps: [] });
    await world.sharingFor({ uid: KYLE.uid, name: 'Kyle', email: KYLE.email, emailVerified: true }).invite({ id: mine.id, name: 'Bait' }, SAM.email);
    return mine;
  }

  test('accepting is refused before anything is written, and says why', async () => {
    const world = new InMemorySharingWorld();
    const sam = person(world, SAM);
    const mine = await clashing(world, sam);
    const user = userEvent.setup();
    open(world, sam);

    const banner = await screen.findByRole('region', { name: /invitations/i }, WAIT);
    await user.click(within(banner).getByRole('button', { name: /accept bait/i }));

    expect(await within(banner).findByRole('alert')).toHaveTextContent(/already one of your cars/i);
    expect(world.isMember(KYLE.uid, mine.id, SAM.uid)).toBe(false);
    expect(await sam.store.fillUps(mine.id)).toHaveLength(1);
    expect((await world.remoteFor(KYLE.uid).pull(null)).fillUps).toHaveLength(0);
  });

  test('a clashing share that exists anyway is reported, never synced', async () => {
    const world = new InMemorySharingWorld();
    const sam = person(world, SAM);
    const mine = await clashing(world, sam);
    const key = `${KYLE.uid}__${mine.id}`;
    world.members.set(key, new Map([[SAM.uid, { uid: SAM.uid, name: 'Sam', email: SAM.email, joinedAt: 1 }]]));
    world.memberships.set(SAM.uid, new Map([[key, { ownerUid: KYLE.uid, vehicleId: mine.id, ownerName: 'Kyle', vehicleName: 'Bait' }]]));
    open(world, sam, 'settings');

    expect(await screen.findByText(/bait from kyle names a car that is already yours/i, {}, WAIT)).toBeInTheDocument();
    expect((await world.remoteFor(KYLE.uid).pull(null)).fillUps).toHaveLength(0);
    expect(await sam.store.fillUps(mine.id)).toHaveLength(1);
  });
});

describe('deleting a car you share (#80)', () => {
  test('removes its members and withdraws its invitations', async () => {
    const world = new InMemorySharingWorld();
    const kyle = person(world, KYLE);
    const car = await kylesCivic(world, kyle);
    const kyleSharing = world.sharingFor({ uid: KYLE.uid, name: 'Kyle', email: KYLE.email, emailVerified: true });
    const invite = await kyleSharing.invite(car, SAM.email);
    await world.sharingFor({ uid: SAM.uid, name: 'Sam', email: SAM.email, emailVerified: true }).accept(invite);
    await kyleSharing.invite(car, 'alex@example.com');
    const user = userEvent.setup();
    open(world, kyle);

    await user.click(await screen.findByRole('button', { name: /^Delete (?!the fill-up)/ }, WAIT));
    await user.click(screen.getByRole('button', { name: /delete civic/i }));

    await waitFor(() => expect(world.isMember(KYLE.uid, car.id, SAM.uid)).toBe(false), WAIT);
    expect(world.invites.size).toBe(0);
  });
});

describe('what a shared car’s sync says (#84)', () => {
  async function samWithKylesCivic(world: InMemorySharingWorld) {
    const kyle = person(world, KYLE);
    const sam = person(world, SAM);
    const car = await kylesCivic(world, kyle);
    const invite = await world.sharingFor({ uid: KYLE.uid, name: 'Kyle', email: KYLE.email, emailVerified: true }).invite(car, SAM.email);
    await world.sharingFor({ uid: SAM.uid, name: 'Sam', email: SAM.email, emailVerified: true }).accept(invite);
    // Sam's first sync brings the car.
    open(world, sam);
    await screen.findByText(/shared with you by kyle/i, {}, WAIT);
    cleanup();
    // The tab is in the address (#56): clear it, or the next mount opens here.
    window.history.replaceState(null, '', '/');
    return { sam, car };
  }

  test('an upload the owner’s account refuses says so — by car — and not that it could not be reached', async () => {
    const world = new InMemorySharingWorld();
    const { sam, car } = await samWithKylesCivic(world);
    const [theirs] = await sam.store.fillUps(car.id);
    const whole = theirs === undefined ? undefined : await sam.store.fillUp(theirs.id);
    if (whole === undefined) throw new Error('no fill-up');
    await sam.store.importBackup({
      vehicles: [],
      fillUps: [{ ...whole, id: 'planted', enteredBy: 'someone-else', updatedAt: Date.now() }],
      pendingFillUps: [],
    });

    open(world, sam, 'settings');

    const notice = await screen.findByText(/were refused by kyle/i, {}, WAIT);
    expect(notice.textContent).toMatch(/civic/i);
    expect(notice.textContent).not.toMatch(/could not be reached/i);
  }, 15_000);

  test('a photo too large to send on a shared car is reported like one on your own', async () => {
    const world = new InMemorySharingWorld();
    const { sam, car } = await samWithKylesCivic(world);
    world.remoteFor(KYLE.uid).receiptByteLimit = 10;
    const made = makeFuelEntryDraft({
      date: new Date(2026, 0, 3),
      odometer: 10_400,
      gallons: 10,
      pricePerGallon: 3.5,
      receiptImageData: new Uint8Array(500),
    });
    if (made === null) throw new Error('fixture draft failed validation');
    await sam.store.addFillUp(made, car.id);

    open(world, sam, 'settings');

    expect(await screen.findByText(/1 receipt photo was too large to sync/i, {}, WAIT)).toBeInTheDocument();
  }, 15_000);
});
