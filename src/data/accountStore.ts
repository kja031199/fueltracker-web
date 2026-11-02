/**
 * Local storage, separated by account.
 *
 * ## The bug this file exists to fix
 *
 * When sign-in shipped, the app opened one IndexedDB database called
 * `fueltracker` — created at module load, before anything was known about the
 * user, and shared by everyone. The *remote* store was correctly per-uid, and
 * nothing cleared the local one on sign-out.
 *
 * On a shared computer that leaked data in both directions. Person A signs out,
 * person B signs in, and B's store still holds A's rows: B's screens show A's
 * vehicles, and worse, the first sync exports those rows and **writes them into
 * B's Firestore tree**, from where they propagate to B's other devices and
 * outlive anything cleared locally.
 *
 * ## Why per-uid names rather than clearing on sign-out
 *
 * Clearing would destroy local edits made before someone signed out and before
 * a sync could carry them up — turning a privacy fix into a data-loss bug.
 * Naming the database after the account leaves each person's rows on the device
 * under their own name, so signing back in finds them.
 *
 * The cost is one database per account that has ever signed in on that device,
 * which is a few hundred kilobytes each and bounded by how many people share
 * the machine.
 */

import { DexieRepository, DexieSyncState, FuelTrackerDatabase } from './db';
import type { SyncStateStore } from './syncState';
import { FuelTrackerStore } from './store';
import { sharedSyncClock } from './syncClock';

/**
 * What the database was called before accounts existed.
 *
 * Still the root of every per-account name (`fueltracker-u-<uid>`). The
 * database of this exact name is **never opened, copied or deleted** — see
 * `openSignedInAccount` for why the one-time rescue that used to read it was
 * removed (#44). Opening it would also create it, which is its own reason to
 * keep away from it.
 */
export const LEGACY_DATABASE_NAME = 'fueltracker';

/** `prefix` exists so tests can isolate databases from each other. */
function withPrefix(prefix: string, name: string): string {
  return prefix === '' ? name : `${prefix}-${name}`;
}

/**
 * The database name for one account.
 *
 * The `-u-` separator is not decoration: without a delimiter, uids `abc` and
 * `abcd` would both have to be distinguished by the raw concatenation, and the
 * thing standing between two people's fuel logs should not be string-prefix
 * luck.
 */
export function databaseNameFor(uid: string, prefix = ''): string {
  return withPrefix(prefix, `${LEGACY_DATABASE_NAME}-u-${uid}`);
}

export interface AccountStore {
  readonly store: FuelTrackerStore;
  /** Where incremental sync keeps its place, in this account's database (#52). */
  readonly syncState: SyncStateStore;
  readonly databaseName: string;
  /** Releases the connection. Called when the signed-in account changes. */
  close(): void;
}

/**
 * Built on the shared monotonic clock, not the wall clock.
 *
 * The store stamps local writes and the sync engine observes remote ones, so
 * they have to be the same instance — otherwise the floor the sync engine
 * learns never reaches the timestamps the store issues, and a device with a
 * fast clock goes on winning. See `syncClock.ts`.
 */
function storeOver(db: FuelTrackerDatabase): FuelTrackerStore {
  return new FuelTrackerStore(
    {
      vehicles: new DexieRepository(db.vehicles),
      fillUps: new DexieRepository(db.fillUps),
      pendingFillUps: new DexieRepository(db.pendingFillUps),
    },
    sharedSyncClock,
  );
}

/** Opens (creating if needed) the store for one account. */
export async function openAccountStore(uid: string, prefix = ''): Promise<AccountStore> {
  const databaseName = databaseNameFor(uid, prefix);
  const db = new FuelTrackerDatabase(databaseName);
  await db.open();
  return {
    store: storeOver(db),
    syncState: new DexieSyncState(db),
    databaseName,
    close: () => db.close(),
  };
}

/**
 * What `main.tsx` does when an account signs in: open that account's own
 * database, and nothing else.
 *
 * ## Why there is no longer a rescue here
 *
 * Issue #44. This used to adopt the pre-accounts `fueltracker` database first —
 * copy it into the signing-in account if that account was empty, verify the
 * copy, then delete the original. It ran on sign-in, before any sync, which is
 * before anything knows whether the account is on the allowlist (#27). So on a
 * device that still held a legacy database, the first account to sign in —
 * including a stranger about to be refused — received the owner's rows, and
 * the owner's copy was deleted. Since #41 the no-access screen then offered to
 * export them.
 *
 * Removed rather than deferred until after a successful sync: it was a
 * migration for a transition that finished long ago, any device the owner has
 * used since adopted its data then, and a migration nobody needs is attack
 * surface nobody watches. A legacy database that still exists is left exactly
 * where it is — it is the owner's, and leaving it costs nothing.
 *
 * The rule this encodes: **nothing that runs on sign-in moves data into an
 * account**, because nothing that runs on sign-in knows who that account is
 * allowed to be. A per-account store holds what that account wrote, and what
 * its sync brought down — nothing else.
 */
export async function openSignedInAccount(uid: string, prefix = ''): Promise<AccountStore> {
  return openAccountStore(uid, prefix);
}
