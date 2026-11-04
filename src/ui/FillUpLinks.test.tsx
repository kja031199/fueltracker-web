// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StubAuthProvider, type AuthUser } from '../data/auth';
import { InMemoryRepository } from '../data/repository';
import type { FillUpRecord, PendingFillUpRecord, VehicleRecord } from '../data/records';
import { FuelTrackerStore } from '../data/store';
import { InMemoryRemoteStore } from '../data/remote';
import { InMemorySharingWorld } from '../data/sharing';
import type { SharingSync } from '../data/shareSync';
import { InMemoryShareLedger, InMemorySyncState } from '../data/syncState';
import {
  LINK_TEXT_LIMITS,
  MAX_LINK_PAYLOAD,
  decodeRequest,
  decodeSubmission,
  encodeRequest,
  encodeSubmission,
  type Submission,
} from '../data/fillUpLink';
import { makeFuelEntryDraft } from '../domain/fuelEntryDraft';
import { App } from './App';
import { saveHasOnboarded } from './onboarding';
import { saveUnitPreferences } from './unitSettings';

/**
 * Fill-ups sent by link (#3), as the two people meet it: the owner asks from
 * Vehicles, the person who filled up answers from the request link, and the
 * owner reviews what comes back under Fill-ups. Nothing reaches a log until
 * its owner approves it.
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

interface OpenOptions {
  readonly store: FuelTrackerStore;
  readonly user?: AuthUser;
  readonly hash?: string;
  readonly remote?: InMemoryRemoteStore | null;
  readonly sharing?: SharingSync | null;
  readonly initialTab?: 'vehicles' | 'fillups' | 'dashboard';
}

function open({ store, user = KYLE, hash, remote = null, sharing = null, initialTab = 'dashboard' }: OpenOptions): void {
  if (hash !== undefined) window.history.replaceState(null, '', `/${hash}`);
  render(
    <App
      store={store}
      auth={new StubAuthProvider({ status: 'signedIn', user })}
      remote={remote}
      sharing={sharing}
      initialTab={initialTab}
    />,
  );
}

function draft(overrides: Partial<Parameters<typeof makeFuelEntryDraft>[0]> = {}) {
  const made = makeFuelEntryDraft({
    date: new Date(2026, 9, 30, 8, 15),
    odometer: 10_300,
    gallons: 9.5,
    pricePerGallon: 3.25,
    station: 'Shell',
    notes: 'After the trip',
    ...overrides,
  });
  if (made === null) throw new Error('fixture draft failed validation');
  return made;
}

function submission(vehicleId: string, overrides: Partial<Submission> = {}): Submission {
  return { id: 'sub-1', vehicleId, submitterName: 'Sam', submittedAt: Date.now() - 1000, draft: draft(), ...overrides };
}

/** The payload after `marker` in the link field labelled `label`. */
function payloadIn(label: RegExp, marker: string): string {
  const field = screen.getByLabelText(label) as HTMLTextAreaElement;
  const [, payload] = field.value.split(marker);
  if (payload === undefined) throw new Error(`no ${marker} in ${field.value}`);
  return payload;
}

beforeEach(() => {
  localStorage.clear();
  saveHasOnboarded(KYLE.uid);
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the owner asks', () => {
  test('Request a fill-up shows a link naming the car and the owner, and nothing else', async () => {
    const store = makeStore(KYLE.uid);
    const car = await store.addVehicle({ name: 'Civic' });
    const user = userEvent.setup();
    open({ store, initialTab: 'vehicles' });

    await user.click(await screen.findByRole('button', { name: 'Request a fill-up' }));
    const field = screen.getByLabelText(/fill-up request for civic/i) as HTMLTextAreaElement;
    expect(field.value.startsWith(`${window.location.origin}${window.location.pathname}#/submit/`)).toBe(true);
    expect(decodeRequest(payloadIn(/fill-up request for civic/i, '#/submit/'))).toEqual({
      ok: true,
      value: { vehicleId: car.id, vehicleName: 'Civic', ownerName: 'Kyle' },
    });
  });

  test('Copy puts the link on the clipboard, and says so', async () => {
    const store = makeStore(KYLE.uid);
    await store.addVehicle({ name: 'Civic' });
    const user = userEvent.setup();
    open({ store, initialTab: 'vehicles' });
    await user.click(await screen.findByRole('button', { name: 'Request a fill-up' }));
    await user.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(await screen.findByText('Copied.')).toBeInTheDocument();
    expect(await navigator.clipboard.readText()).toBe(
      (screen.getByLabelText(/fill-up request/i) as HTMLTextAreaElement).value,
    );
  });

  test('a clipboard that refuses is admitted to, not papered over', async () => {
    const store = makeStore(KYLE.uid);
    await store.addVehicle({ name: 'Civic' });
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    open({ store, initialTab: 'vehicles' });
    await user.click(await screen.findByRole('button', { name: 'Request a fill-up' }));
    await user.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(await screen.findByText(/would not copy it/i)).toBeInTheDocument();
    expect(screen.queryByText('Copied.')).not.toBeInTheDocument();
  });

  test('Share is offered only where the browser has a share sheet', async () => {
    const store = makeStore(KYLE.uid);
    await store.addVehicle({ name: 'Civic' });
    const user = userEvent.setup();
    open({ store, initialTab: 'vehicles' });
    await user.click(await screen.findByRole('button', { name: 'Request a fill-up' }));
    expect(screen.queryByRole('button', { name: /share…/i })).not.toBeInTheDocument();
    cleanup();

    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'share', { value: share, configurable: true });
    try {
      open({ store, initialTab: 'vehicles' });
      await user.click(await screen.findByRole('button', { name: 'Request a fill-up' }));
      await user.click(screen.getByRole('button', { name: /share…/i }));
      expect(share).toHaveBeenCalledWith({
        title: 'Fill-up request for Civic',
        url: (screen.getByLabelText(/fill-up request/i) as HTMLTextAreaElement).value,
      });
    } finally {
      Reflect.deleteProperty(navigator, 'share');
    }
  });

  test('a car shared with you is its owner’s to ask about: no request on it', async () => {
    const world = new InMemorySharingWorld();
    const kyleStore = makeStore(KYLE.uid);
    const civic = await kyleStore.addVehicle({ name: 'Civic' });
    await world.remoteFor(KYLE.uid).push(await kyleStore.exportSnapshot());
    await world.sharingFor({ uid: KYLE.uid, name: 'Kyle', email: KYLE.email, emailVerified: true }).invite(civic, SAM.email);
    const samRemote = world.sharingFor({ uid: SAM.uid, name: 'Sam', email: SAM.email, emailVerified: true });
    const [invite] = await samRemote.invitesForMe();
    if (invite === undefined) throw new Error('no invite');
    await samRemote.accept(invite);

    saveHasOnboarded(SAM.uid);
    const samStore = makeStore(SAM.uid);
    await samStore.addVehicle({ name: 'Corolla' });
    open({ store: samStore, user: SAM, remote: world.remoteFor(SAM.uid), sharing: sharingFor(world, SAM), initialTab: 'vehicles' });

    const shared = (await screen.findByText(/shared with you by kyle/i, {}, WAIT)).closest('li');
    if (shared === null) throw new Error('no shared row');
    expect(within(shared).queryByRole('button', { name: 'Request a fill-up' })).not.toBeInTheDocument();
    const own = screen.getByText('Corolla').closest('li');
    if (own === null) throw new Error('no own row');
    expect(within(own).getByRole('button', { name: 'Request a fill-up' })).toBeInTheDocument();
  });
});

describe('the submitter answers', () => {
  const requestHash = (vehicleId = 'car-123') =>
    `#/submit/${encodeRequest({ vehicleId, vehicleName: 'Civic', ownerName: 'Kyle' })}`;

  test('fills it in and gets a link back — and nothing lands in their own log', async () => {
    // Sam has no cars and has never onboarded: the request is still what they see.
    const store = makeStore(SAM.uid);
    const user = userEvent.setup();
    open({ store, user: SAM, hash: requestHash() });

    expect(await screen.findByText(/kyle asked you to log a fill-up for/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Your name')).toHaveValue('Sam');
    await user.type(screen.getByLabelText(/odometer/i), '10300');
    await user.type(screen.getByLabelText('Gallons'), '9.5');
    await user.type(screen.getByLabelText(/price per gallon/i), '3.25');
    await user.type(screen.getByLabelText(/gas station/i), 'Shell');
    await user.click(screen.getByRole('button', { name: 'Create link' }));

    const decoded = decodeSubmission(payloadIn(/fill-up for civic/i, '#/incoming/'));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value).toMatchObject({ vehicleId: 'car-123', submitterName: 'Sam' });
    expect(decoded.value.draft).toMatchObject({ odometer: 10_300, gallons: 9.5, pricePerGallon: 3.25, station: 'Shell' });

    expect(await store.vehicles()).toHaveLength(0);
    expect(await store.fillUpCount()).toBe(0);
    expect(await store.pendingFillUps()).toHaveLength(0);
  });

  test('a form in litres and kilometres still sends canonical gallons and miles', async () => {
    saveUnitPreferences({ volume: 'liters', distance: 'kilometers', economy: 'litersPer100km' });
    const user = userEvent.setup();
    open({ store: makeStore(SAM.uid), user: SAM, hash: requestHash() });
    await user.type(await screen.findByLabelText(/odometer/i), '16093.44');
    await user.type(screen.getByLabelText('Liters'), '37.854');
    await user.type(screen.getByLabelText(/price per liter/i), '1');
    await user.click(screen.getByRole('button', { name: 'Create link' }));
    const decoded = decodeSubmission(payloadIn(/fill-up for civic/i, '#/incoming/'));
    expect(decoded.ok && decoded.value.draft.odometer).toBeCloseTo(10_000, 3);
    expect(decoded.ok && decoded.value.draft.gallons).toBeCloseTo(10, 3);
    expect(decoded.ok && decoded.value.draft.pricePerGallon).toBeCloseTo(3.785, 3);
  });

  test('offers no photo and no "missed" box: a link carries neither', async () => {
    open({ store: makeStore(SAM.uid), user: SAM, hash: requestHash() });
    await screen.findByText(/kyle asked you/i);
    expect(screen.queryByRole('button', { name: /receipt photo/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/missed logging/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/gas station/i)).toHaveAttribute('maxLength', String(LINK_TEXT_LIMITS.station));
    expect(screen.getByLabelText(/notes/i)).toHaveAttribute('maxLength', String(LINK_TEXT_LIMITS.notes));
  });

  test('cannot make a link from a fill-up that does not add up', async () => {
    const user = userEvent.setup();
    open({ store: makeStore(SAM.uid), user: SAM, hash: requestHash() });
    await user.type(await screen.findByLabelText(/odometer/i), '10300');
    await user.type(screen.getByLabelText('Gallons'), '0');
    await user.type(screen.getByLabelText(/price per gallon/i), '3.25');
    expect(screen.getByRole('button', { name: 'Create link' })).toBeDisabled();
  });

  test('Cancel leaves the link, replacing it so Back does not reopen it', async () => {
    const user = userEvent.setup();
    open({ store: makeStore(SAM.uid), user: SAM, hash: requestHash() });
    const before = window.history.length;
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(window.location.hash).toBe('#/dashboard');
    expect(window.history.length).toBe(before);
  });

  test.each([
    ['damaged', '#/submit/not*base64', /damaged/i],
    ['too long', `#/submit/${'A'.repeat(MAX_LINK_PAYLOAD + 1)}`, /far longer/i],
    ['a submission, not a request', `#/submit/${encodeSubmission(submission('car-1'))}`, /not a fill-up request/i],
    ['from a newer version', `#/submit/${btoa(JSON.stringify({ v: 2, k: 'req', car: 'c' })).replace(/=+$/, '')}`, /newer version/i],
    ['naming no car', `#/submit/${btoa(JSON.stringify({ v: 1, k: 'req', car: '../x' })).replace(/=+$/, '')}`, /does not name a car/i],
  ])('a request that is %s says so, and offers the way out', async (_label, hash, message) => {
    const user = userEvent.setup();
    open({ store: makeStore(SAM.uid), user: SAM, hash });
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(screen.queryByRole('button', { name: 'Create link' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Go to FuelTracker' }));
    expect(window.location.hash).toBe('#/dashboard');
  });

  test('each visit mints its own submission id', async () => {
    const user = userEvent.setup();
    const ids: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      open({ store: makeStore(SAM.uid), user: SAM, hash: requestHash() });
      await user.type(await screen.findByLabelText(/odometer/i), '10300');
      await user.type(screen.getByLabelText('Gallons'), '9.5');
      await user.type(screen.getByLabelText(/price per gallon/i), '3.25');
      await user.click(screen.getByRole('button', { name: 'Create link' }));
      const decoded = decodeSubmission(payloadIn(/fill-up for civic/i, '#/incoming/'));
      if (decoded.ok) ids.push(decoded.value.id);
      cleanup();
    }
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});

describe('the owner reviews', () => {
  async function kyleWithCivic(): Promise<{ store: FuelTrackerStore; car: VehicleRecord }> {
    const store = makeStore(KYLE.uid);
    const car = await store.addVehicle({ name: 'Civic' });
    return { store, car };
  }

  test('opening the link queues it and shows it waiting, without a history entry', async () => {
    const { store, car } = await kyleWithCivic();
    const before = window.history.length;
    open({ store, hash: `#/incoming/${encodeSubmission(submission(car.id))}` });

    const review = await screen.findByRole('region', { name: /waiting for review \(1\)/i }, WAIT);
    expect(within(review).getByText('Civic')).toBeInTheDocument();
    expect(within(review).getByText(/from sam/i)).toBeInTheDocument();
    expect(window.location.hash).toBe('#/fillups');
    expect(window.history.length).toBe(before);
    expect(await store.fillUpCount()).toBe(0);
  });

  test('Approve adds it to the log as the owner’s, and syncs it', async () => {
    const { store, car } = await kyleWithCivic();
    const remote = new InMemoryRemoteStore();
    const user = userEvent.setup();
    open({ store, remote, hash: `#/incoming/${encodeSubmission(submission(car.id))}` });

    await user.click(await screen.findByRole('button', { name: /approve the fill-up from sam for civic/i }, WAIT));
    await waitFor(() => expect(screen.queryByRole('region', { name: /waiting for review/i })).not.toBeInTheDocument());
    expect(await screen.findByText(/10,300/)).toBeInTheDocument();
    const [made] = await store.fillUps(car.id);
    expect(made).toMatchObject({ odometer: 10_300, station: 'Shell', enteredBy: KYLE.uid });
    await waitFor(async () => {
      const pulled = await remote.pull(null);
      expect(pulled.fillUps).toHaveLength(1);
    }, WAIT);
  }, 10_000);

  test('Reject drops it, and the log is untouched', async () => {
    const { store, car } = await kyleWithCivic();
    const user = userEvent.setup();
    open({ store, hash: `#/incoming/${encodeSubmission(submission(car.id))}` });
    await user.click(await screen.findByRole('button', { name: /reject the fill-up from sam/i }, WAIT));
    await waitFor(() => expect(screen.queryByRole('region', { name: /waiting for review/i })).not.toBeInTheDocument());
    expect(await store.fillUpCount()).toBe(0);
    expect(await store.pendingFillUps()).toHaveLength(0);
  });

  test('the same link opened again is received once, and says so', async () => {
    const { store, car } = await kyleWithCivic();
    const hash = `#/incoming/${encodeSubmission(submission(car.id))}`;
    open({ store, hash });
    await screen.findByRole('region', { name: /waiting for review/i }, WAIT);
    cleanup();

    const user = userEvent.setup();
    open({ store, hash });
    expect(await screen.findByRole('alert', {}, WAIT)).toHaveTextContent(/already received/i);
    expect(await store.pendingFillUps()).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Go to fill-ups' }));
    expect(window.location.hash).toBe('#/fillups');
  });

  test('a link already approved is not queued again', async () => {
    const { store, car } = await kyleWithCivic();
    await store.receiveSubmission(submission(car.id));
    await store.approvePendingFillUp('sub-1');
    open({ store, hash: `#/incoming/${encodeSubmission(submission(car.id))}` });
    expect(await screen.findByRole('alert', {}, WAIT)).toHaveTextContent(/already received/i);
    expect(await store.fillUpCount()).toBe(1);
  });

  test('every car’s submissions wait together, whichever car is selected', async () => {
    const { store, car } = await kyleWithCivic();
    const truck = await store.addVehicle({ name: 'Truck' });
    await store.receiveSubmission(submission(car.id, { id: 'a' }));
    await store.receiveSubmission(submission(truck.id, { id: 'b', submitterName: 'Alex' }));
    open({ store, initialTab: 'fillups' });
    const review = await screen.findByRole('region', { name: /waiting for review \(2\)/i }, WAIT);
    expect(within(review).getByText('Civic')).toBeInTheDocument();
    expect(within(review).getByText('Truck')).toBeInTheDocument();
  });

  test('a submission whose car was deleted can only be rejected', async () => {
    const { store, car } = await kyleWithCivic();
    await store.addVehicle({ name: 'Truck' });
    await store.receiveSubmission(submission(car.id));
    await store.removeVehicle(car.id);
    const user = userEvent.setup();
    open({ store, initialTab: 'fillups' });
    const review = await screen.findByRole('region', { name: /waiting for review/i }, WAIT);
    expect(within(review).getByText('A deleted car')).toBeInTheDocument();
    expect(within(review).queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
    await user.click(within(review).getByRole('button', { name: /reject/i }));
    await waitFor(() => expect(screen.queryByRole('region', { name: /waiting for review/i })).not.toBeInTheDocument());
  });

  test('an approval that is refused says so and leaves the submission waiting', async () => {
    const pendingFillUps = new InMemoryRepository<PendingFillUpRecord>();
    const store = new FuelTrackerStore(
      { vehicles: new InMemoryRepository<VehicleRecord>(), fillUps: new InMemoryRepository<FillUpRecord>(), pendingFillUps },
      undefined,
      KYLE.uid,
    );
    const car = await store.addVehicle({ name: 'Civic' });
    await store.receiveSubmission(submission(car.id));
    // Tampered with in storage (or synced from a bad build) since it was queued.
    const [row] = await store.pendingFillUps();
    if (row === undefined) throw new Error('no row');
    await pendingFillUps.put({ ...row, gallons: -1 });
    const user = userEvent.setup();
    open({ store, initialTab: 'fillups' });
    await user.click(await screen.findByRole('button', { name: /approve/i }, WAIT));
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be added/i);
    expect(await store.fillUpCount()).toBe(0);
    expect(await store.pendingFillUps()).toHaveLength(1);
  });

  test('a car not here yet is looked for in the account before giving up', async () => {
    // A fresh device: the car is in the account but has not synced down.
    const elsewhere = makeStore(KYLE.uid);
    const car = await elsewhere.addVehicle({ name: 'Civic' });
    const remote = new InMemoryRemoteStore(await elsewhere.exportSnapshot());
    const store = makeStore(KYLE.uid);
    open({ store, remote, hash: `#/incoming/${encodeSubmission(submission(car.id))}` });
    expect(await screen.findByRole('region', { name: /waiting for review \(1\)/i }, WAIT)).toBeInTheDocument();
  });

  test('the car arriving only after the first sync is still found: the refusal waits for a fresh one', async () => {
    // The mount sync finds nothing; the car reaches the account a moment later.
    const elsewhere = makeStore(KYLE.uid);
    const car = await elsewhere.addVehicle({ name: 'Civic' });
    const later = await elsewhere.exportSnapshot();
    class LateRemote extends InMemoryRemoteStore {
      pulls = 0;
      override async pull(...args: Parameters<InMemoryRemoteStore['pull']>) {
        this.pulls += 1;
        if (this.pulls === 2) await this.push(later);
        return super.pull(...args);
      }
    }
    const remote = new LateRemote();
    const store = makeStore(KYLE.uid);
    open({ store, remote, hash: `#/incoming/${encodeSubmission(submission(car.id))}` });
    expect(await screen.findByRole('region', { name: /waiting for review \(1\)/i }, WAIT)).toBeInTheDocument();
    expect(remote.pulls).toBeGreaterThanOrEqual(2);
  });

  test('a car that is in neither place is refused plainly', async () => {
    const { store } = await kyleWithCivic();
    open({ store, remote: new InMemoryRemoteStore(), hash: `#/incoming/${encodeSubmission(submission('gone-car'))}` });
    expect(await screen.findByRole('alert', {}, WAIT)).toHaveTextContent(/not in your log/i);
    expect(await store.pendingFillUps()).toHaveLength(0);
  });

  test('a fill-up for a car shared with you is not yours to receive', async () => {
    const world = new InMemorySharingWorld();
    const kyleStore = makeStore(KYLE.uid);
    const civic = await kyleStore.addVehicle({ name: 'Civic' });
    await world.remoteFor(KYLE.uid).push(await kyleStore.exportSnapshot());
    await world.sharingFor({ uid: KYLE.uid, name: 'Kyle', email: KYLE.email, emailVerified: true }).invite(civic, SAM.email);
    const samRemote = world.sharingFor({ uid: SAM.uid, name: 'Sam', email: SAM.email, emailVerified: true });
    const [invite] = await samRemote.invitesForMe();
    if (invite === undefined) throw new Error('no invite');
    await samRemote.accept(invite);

    saveHasOnboarded(SAM.uid);
    const samStore = makeStore(SAM.uid);
    open({
      store: samStore,
      user: SAM,
      remote: world.remoteFor(SAM.uid),
      sharing: sharingFor(world, SAM),
      hash: `#/incoming/${encodeSubmission(submission(civic.id, { submitterName: 'Alex' }))}`,
    });
    expect(await screen.findByRole('alert', {}, WAIT)).toHaveTextContent(/shared with you, not one of yours/i);
    expect(await samStore.pendingFillUps()).toHaveLength(0);
  });

  test.each([
    ['damaged', '#/incoming/%%%', /damaged/i],
    ['too long', `#/incoming/${'A'.repeat(MAX_LINK_PAYLOAD + 1)}`, /far longer/i],
    ['a request, not a fill-up', `#/incoming/${encodeRequest({ vehicleId: 'c', vehicleName: 'C', ownerName: 'K' })}`, /not a fill-up link/i],
    ['impossible', `#/incoming/${btoa(JSON.stringify({ v: 1, k: 'sub', id: 's', car: 'c', d: Date.now(), o: 1, g: 0, p: 1 })).replace(/=+$/, '')}`, /does not add up/i],
    ['from a newer version', `#/incoming/${btoa(JSON.stringify({ v: 3, k: 'sub' })).replace(/=+$/, '')}`, /newer version/i],
  ])('a fill-up link that is %s is refused, and nothing is queued', async (_label, hash, message) => {
    const { store } = await kyleWithCivic();
    const user = userEvent.setup();
    open({ store, hash });
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(await store.pendingFillUps()).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Go to FuelTracker' }));
    expect(window.location.hash).toBe('#/dashboard');
  });
});

describe('the whole round trip', () => {
  test('owner asks, submitter answers, owner approves', async () => {
    const user = userEvent.setup();
    const kyleStore = makeStore(KYLE.uid);
    const car = await kyleStore.addVehicle({ name: 'Civic' });

    open({ store: kyleStore, initialTab: 'vehicles' });
    await user.click(await screen.findByRole('button', { name: 'Request a fill-up' }));
    const requestLink = (screen.getByLabelText(/fill-up request/i) as HTMLTextAreaElement).value;
    cleanup();

    open({ store: makeStore(SAM.uid), user: SAM, hash: requestLink.slice(requestLink.indexOf('#')) });
    await user.type(await screen.findByLabelText(/odometer/i), '10300');
    await user.type(screen.getByLabelText('Gallons'), '9.5');
    await user.type(screen.getByLabelText(/price per gallon/i), '3.25');
    await user.click(screen.getByRole('button', { name: 'Create link' }));
    const submissionLink = (screen.getByLabelText(/fill-up for civic/i) as HTMLTextAreaElement).value;
    cleanup();

    open({ store: kyleStore, hash: submissionLink.slice(submissionLink.indexOf('#')) });
    await user.click(await screen.findByRole('button', { name: /approve the fill-up from sam for civic/i }, WAIT));
    await waitFor(async () => expect(await kyleStore.fillUps(car.id)).toHaveLength(1));
  });
});

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
