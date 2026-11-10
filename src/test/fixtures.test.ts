import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { InMemorySharingWorld } from '../data/sharing';
import { MonotonicClock } from '../data/syncClock';
import { DRAFT_DEFAULTS, draft, draftWith, makeStore, sharingFor } from './fixtures';
import { sourcesUnder } from './imports';

/**
 * The shared fixtures (#97), and the rule that they stay shared: `makeStore`
 * was defined in 18 files and `draft` in 16, and copies drift — one
 * `makeStore()` quietly made every fill-up "entered by owner", which nobody
 * could tell from its name.
 */

describe('draft', () => {
  test('the defaults, through the real gate', () => {
    const made = draft();
    expect(made.odometer).toBe(DRAFT_DEFAULTS.odometer);
    expect(made.gallons).toBe(DRAFT_DEFAULTS.gallons);
    expect(made.pricePerGallon).toBe(DRAFT_DEFAULTS.pricePerGallon);
    expect(made.date).toEqual(DRAFT_DEFAULTS.date);
  });

  test('a number is the odometer reading; an object is changes over the defaults', () => {
    expect(draft(12_345).odometer).toBe(12_345);
    const changed = draft({ station: 'Shell', gallons: 9.5 });
    expect([changed.station, changed.gallons, changed.odometer]).toEqual(['Shell', 9.5, DRAFT_DEFAULTS.odometer]);
  });

  test('a fixture the gate refuses is a broken test, said where it was made', () => {
    expect(() => draft({ gallons: 0 })).toThrow(/fixture draft failed validation/);
    expect(() => draft(Number.NaN)).toThrow(/fixture draft failed validation/);
  });

  test('draftWith changes the defaults, and a test’s changes still win over them', () => {
    const older = draftWith({ date: new Date(2025, 0, 15), station: 'Shell' });
    expect(older().date).toEqual(new Date(2025, 0, 15));
    expect(older().station).toBe('Shell');
    expect(older({ station: 'Costco' }).station).toBe('Costco');
    expect(older(10_300).odometer).toBe(10_300);
  });

  test('each call is its own draft', () => {
    expect(draft()).not.toBe(draft());
  });
});

describe('makeStore', () => {
  test('an empty store, with nobody entering fill-ups unless an author is given', async () => {
    const plain = makeStore();
    expect(await plain.vehicles()).toEqual([]);
    const car = await plain.addVehicle({ name: 'Civic' });
    expect((await plain.addFillUp(draft(), car.id)).enteredBy).toBeNull();

    const kyles = makeStore({ author: 'kyle' });
    const his = await kyles.addVehicle({ name: 'Civic' });
    expect((await kyles.addFillUp(draft(), his.id)).enteredBy).toBe('kyle');
  });

  test('the clock it is given is the one it stamps with', async () => {
    const clock = new MonotonicClock(() => 5_000);
    const store = makeStore({ clock });
    expect(store.clock).toBe(clock);
    expect((await store.addVehicle({ name: 'Civic' })).updatedAt).toBeGreaterThanOrEqual(5_000);
  });

  test('two stores share nothing', async () => {
    const one = makeStore();
    await one.addVehicle({ name: 'Civic' });
    expect(await makeStore().vehicles()).toEqual([]);
  });
});

describe('sharingFor', () => {
  test('a signed-in user and a sharing account reach the same remote, verified or not', async () => {
    const world = new InMemorySharingWorld();
    const user = { uid: 'u', email: 'u@example.com', displayName: 'U', emailVerified: true };
    const account = { uid: 'u', name: 'U', email: 'u@example.com', emailVerified: true };
    expect(await sharingFor(world, user).remote.invitesForMe()).toEqual([]);
    expect(await sharingFor(world, account).remote.invitesForMe()).toEqual([]);
    expect(world.reads.invitesForMe).toBe(2);
  });

  test('a cursor per shared car is kept, so the next sync reads on from the last', () => {
    const sharing = sharingFor(new InMemorySharingWorld(), { uid: 'u', name: 'U', email: 'u@example.com', emailVerified: true });
    expect(sharing.stateFor('car-1')).toBe(sharing.stateFor('car-1'));
    expect(sharing.stateFor('car-1')).not.toBe(sharing.stateFor('car-2'));
  });
});

/** A second definition of a shared fixture, in any of the spellings tests used. */
const REDEFINED =
  /^(?:export )?(?:async )?function (makeStore|storeFor|draft|sharingFor|allowedUidsInRules)\(|^const (makeStore|storeFor|draft|sharingFor) = (?!draftWith\()/m;

/** The three empty repositories, built by hand — `makeStore()` is that. */
const HAND_BUILT_STORE =
  /new FuelTrackerStore\(\s*\{\s*vehicles: new InMemoryRepository<VehicleRecord>\(\),\s*fillUps: new InMemoryRepository<FillUpRecord>\(\),\s*pendingFillUps: new InMemoryRepository<PendingFillUpRecord>\(\),?\s*\}\s*\)/;

describe('the fixtures are defined once', () => {
  test('the checks find a copy in every spelling, and let a file’s own defaults through', () => {
    for (const copy of ['function makeStore(): FuelTrackerStore {', 'async function makeStore() {', 'function draft(odometer: number) {', 'const draft = (odometer: number) =>', 'function sharingFor(world) {', 'function allowedUidsInRules(): string[] {', 'function storeFor(account) {']) {
      expect(REDEFINED.test(copy), copy).toBe(true);
    }
    for (const fine of ["const draft = draftWith({ station: 'Shell' });", 'const fillUpAt = (odometer: number) => draft({ odometer });', 'store.draft(x)']) {
      expect(REDEFINED.test(fine), fine).toBe(false);
    }
    const handBuilt = `new FuelTrackerStore({
      vehicles: new InMemoryRepository<VehicleRecord>(),
      fillUps: new InMemoryRepository<FillUpRecord>(),
      pendingFillUps: new InMemoryRepository<PendingFillUpRecord>(),
    })`;
    expect(HAND_BUILT_STORE.test(handBuilt)).toBe(true);
    expect(HAND_BUILT_STORE.test('new FuelTrackerStore(repos, clock)')).toBe(false);
  });

  const TESTS = sourcesUnder('src').filter((file) => /\.test\.tsx?$/.test(file));

  test('there are test files to check', () => {
    expect(TESTS.length).toBeGreaterThan(80);
  });

  test.each(TESTS.filter((file) => file !== 'src/test/fixtures.test.ts'))('%s', (file) => {
    const source = readFileSync(file, 'utf8');
    expect(source.match(REDEFINED)?.[0] ?? null).toBeNull();
    expect(source.match(HAND_BUILT_STORE)?.[0] ?? null).toBeNull();
  });
});
