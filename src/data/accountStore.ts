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

import Dexie from 'dexie';
import { DexieRepository, FuelTrackerDatabase } from './db';
import { FuelTrackerStore } from './store';

/**
 * What the database was called before accounts existed.
 *
 * Kept as a constant because it is now only ever read in order to be migrated
 * away from, and a literal in two places would be a way for the migration to
 * quietly stop finding anything.
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
  readonly databaseName: string;
  /** Releases the connection. Called when the signed-in account changes. */
  close(): void;
}

function storeOver(db: FuelTrackerDatabase): FuelTrackerStore {
  return new FuelTrackerStore({
    vehicles: new DexieRepository(db.vehicles),
    fillUps: new DexieRepository(db.fillUps),
    pendingFillUps: new DexieRepository(db.pendingFillUps),
  });
}

/** Opens (creating if needed) the store for one account. */
export async function openAccountStore(uid: string, prefix = ''): Promise<AccountStore> {
  const databaseName = databaseNameFor(uid, prefix);
  const db = new FuelTrackerDatabase(databaseName);
  await db.open();
  return { store: storeOver(db), databaseName, close: () => db.close() };
}

export interface AdoptionResult {
  readonly adopted: boolean;
  readonly vehicles: number;
  readonly fillUps: number;
  readonly pendingFillUps: number;
  /** Set when adoption was declined, for logging rather than for display. */
  readonly reason?: string;
}

const NOTHING: AdoptionResult = {
  adopted: false,
  vehicles: 0,
  fillUps: 0,
  pendingFillUps: 0,
};

/**
 * Moves the pre-account database into the first account that signs in.
 *
 * This is a one-time rescue of data that already exists on a device, not a rule
 * that whoever signs in inherits whatever was lying around — so it refuses in
 * three cases: there is no legacy database, it is empty, or the target account
 * already has rows of its own.
 *
 * **The legacy database is deleted once the copy is verified**, and that
 * deletion is what makes the operation idempotent and safe. There is nowhere
 * else to record "already claimed": this runs in a plain module with no access
 * to a per-origin flag it can trust (local storage can be cleared
 * independently of IndexedDB, which would let the adoption run a second time
 * and hand one person's data to the next account to sign in).
 *
 * The copy is verified by row count *before* anything is deleted, so a partial
 * failure leaves the legacy database untouched and reports `adopted: false`.
 */
export async function adoptLegacyDatabase(uid: string, prefix = ''): Promise<AdoptionResult> {
  const legacyName = withPrefix(prefix, LEGACY_DATABASE_NAME);

  // Checked rather than opened: opening a Dexie database creates it, which
  // would make "is there a legacy database?" true forever after the first ask.
  if (!(await Dexie.exists(legacyName))) {
    return { ...NOTHING, reason: 'no legacy database' };
  }

  const legacyDb = new FuelTrackerDatabase(legacyName);
  await legacyDb.open();
  const legacy = storeOver(legacyDb);
  const snapshot = await legacy.exportSnapshot();
  const counts = {
    vehicles: snapshot.vehicles.length,
    fillUps: snapshot.fillUps.length,
    pendingFillUps: snapshot.pendingFillUps.length,
  };
  const total = counts.vehicles + counts.fillUps + counts.pendingFillUps;

  if (total === 0) {
    legacyDb.close();
    await Dexie.delete(legacyName);
    return { ...NOTHING, reason: 'legacy database empty' };
  }

  const target = await openAccountStore(uid, prefix);
  const existing = await target.store.exportSnapshot();
  const targetTotal =
    existing.vehicles.length + existing.fillUps.length + existing.pendingFillUps.length;

  if (targetTotal > 0) {
    legacyDb.close();
    target.close();
    return { ...NOTHING, reason: 'account already has data' };
  }

  // `importBackup`, not a raw copy: it is the tested merge, it carries
  // tombstones across as tombstones, and it puts every fill-up through the
  // draft gate — so a row that was already corrupt locally is reported here
  // rather than carried into the account and synced.
  const summary = await target.store.importBackup(snapshot);

  const written = summary.vehiclesWritten + summary.fillUpsWritten + summary.pendingWritten;
  const verified = written + summary.rejected.length === total;

  legacyDb.close();
  target.close();

  if (!verified) {
    // Leave the legacy database in place. Reporting failure and keeping the
    // original is the only acceptable outcome; deleting it on a partial copy
    // is the data loss this whole function exists to avoid.
    return { ...NOTHING, reason: 'copy could not be verified' };
  }

  await Dexie.delete(legacyName);

  return {
    adopted: true,
    vehicles: summary.vehiclesWritten,
    fillUps: summary.fillUpsWritten,
    pendingFillUps: summary.pendingWritten,
  };
}
