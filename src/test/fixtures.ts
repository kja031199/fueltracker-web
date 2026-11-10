/**
 * The fixtures the tests share (#97).
 *
 * `makeStore` was written out in 18 files, `draft` in 16, `sharingFor` in 5 —
 * mostly byte for byte, and where they differed it was in defaults nobody had
 * chosen on purpose. One of each now, and a file that needs other defaults
 * says so in one line: `const draft = draftWith({ date: … })`.
 * `oneFixture.test.ts` refuses another definition.
 */

import { InMemoryRepository } from '../data/repository';
import type { FillUpRecord, PendingFillUpRecord, VehicleRecord } from '../data/records';
import { FuelTrackerStore } from '../data/store';
import type { MonotonicClock } from '../data/syncClock';
import type { SharingSync } from '../data/shareSync';
import type { Account } from '../data/sharingTypes';
import type { InMemorySharingWorld } from '../data/sharing';
import { InMemorySyncState } from '../data/syncState';
import { InMemoryShareLedger } from '../data/shareLedger';
import type { AuthUser } from '../data/auth';
import type { FuelEntryDraft } from '../domain/fuelEntryDraft';
import { makeFuelEntryDraft } from '../domain/fuelEntryDraft';

/** A store over empty in-memory repositories. */
export function makeStore(options: { readonly author?: string; readonly clock?: MonotonicClock } = {}): FuelTrackerStore {
  return new FuelTrackerStore(
    {
      vehicles: new InMemoryRepository<VehicleRecord>(),
      fillUps: new InMemoryRepository<FillUpRecord>(),
      pendingFillUps: new InMemoryRepository<PendingFillUpRecord>(),
    },
    options.clock,
    options.author ?? null,
  );
}

export type DraftInput = Partial<Parameters<typeof makeFuelEntryDraft>[0]>;

/** What a fixture fill-up is unless a test says otherwise: an ordinary full tank. */
export const DRAFT_DEFAULTS = {
  date: new Date(2026, 0, 1),
  odometer: 10_000,
  gallons: 10,
  pricePerGallon: 3.5,
} as const;

/**
 * A draft through the real gate (`makeFuelEntryDraft`), with a test's changes
 * over `base`. A number is the odometer reading, the change tests make most.
 * Throws rather than return null: a fixture that fails validation is a broken
 * test, and should say so where it was made.
 */
function build(base: DraftInput, overrides: DraftInput | number): FuelEntryDraft {
  const changes = typeof overrides === 'number' ? { odometer: overrides } : overrides;
  const made = makeFuelEntryDraft({ ...DRAFT_DEFAULTS, ...base, ...changes });
  if (made === null) throw new Error(`fixture draft failed validation: ${JSON.stringify(changes)}`);
  return made;
}

/** A fill-up draft: the defaults, a test's changes over them, or just an odometer reading. */
export function draft(overrides: DraftInput | number = {}): FuelEntryDraft {
  return build({}, overrides);
}

/** `draft`, with other defaults for a file that needs them. */
export function draftWith(base: DraftInput): (overrides?: DraftInput | number) => FuelEntryDraft {
  return (overrides = {}) => build(base, overrides);
}

/**
 * What an account shares through, against an in-memory world: its sharing
 * remote, a sync cursor per shared car (kept, so a later sync reads on from
 * where the last stopped), and its own ledger. Takes a signed-in user or a
 * sharing account.
 */
export function sharingFor(world: InMemorySharingWorld, who: AuthUser | Account): SharingSync {
  const account: Account =
    'displayName' in who
      ? { uid: who.uid, name: who.displayName, email: who.email, emailVerified: who.emailVerified === true }
      : who;
  const states = new Map<string, InMemorySyncState>();
  return {
    remote: world.sharingFor(account),
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
