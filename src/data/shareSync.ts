/**
 * Syncing an account **and** the cars shared with it (#66).
 *
 * `syncOnce` reconciles this device with one remote. A member has more than
 * one: their own account, and each shared car in its owner's account. This
 * runs them in order, keeps each one's rows to itself, and notices when a
 * shared car stops being shared.
 *
 * 1. **The account's own sync**, scoped to exclude every shared car. Without
 *    that scope the owner's car would be pushed into the member's own account
 *    — a copy nobody asked for, which would then diverge for ever.
 * 2. **One sync per shared car**, against `SharingRemote.scoped`: that car's
 *    fill-ups only, and never the car itself, which the rules keep the
 *    owner's to edit. Each has its own cursor (`stateFor`).
 * 3. **Ended shares are forgotten.** A car in the ledger but no longer in the
 *    membership list (left elsewhere), one whose sync is refused (removed by
 *    the owner), and one the owner deleted are all `forgetVehicle`d — a hard
 *    delete with no tombstone, because those rows were never this account's
 *    to delete.
 *
 * If the membership list cannot be read — offline, say — the account's own
 * sync still runs, shared rows are kept and still excluded, and nothing is
 * forgotten on the strength of a failed read.
 *
 * ## The ledger fails closed (#77)
 *
 * The ledger — the cars this device holds for someone else — is what keeps
 * those cars out of step 1 when the membership list cannot say. So:
 *
 * - **A ledger that cannot be read stops the sync.** It used to read as
 *   "nothing is shared", and if the membership list was unreachable too, the
 *   account's own sync pushed the shared car — other people's fill-ups,
 *   receipts and notes — into this account. Even with the list readable it is
 *   not enough: a car left on another device is no longer in the list but is
 *   still on this one. Nothing is synced, nothing is forgotten, and the next
 *   sync tries again.
 * - **A share is recorded before any of its rows arrive.** The ledger is
 *   saved with every current share *before* step 2 pulls anything, so a
 *   failed save at the end — or a tab closed in between — cannot leave shared
 *   rows on this device that the ledger does not know about. If that first
 *   save fails, no share is pulled this time.
 *
 * ## A share whose car id is already here is never synced (#78)
 *
 * A car's id is not secret — request links and CSV exports carry it — and an
 * owner can file their car under any id. Shared under the id of one of *this*
 * account's cars, step 2 would push this account's own fill-ups and receipts
 * into the inviter's, and leaving would later delete the car here. The rules
 * refuse such a join and accepting checks first; this is the last guard, for a
 * membership that got past both (accepted on a device that had not synced the
 * car yet). A **new** share — not in the ledger — whose car is already on this
 * device is reported as `clashed`: never synced, never recorded as held, and
 * still kept out of the account's own push until it is left, so it fails
 * closed. Nothing is deleted.
 */

import type { FuelTrackerStore } from './store';
import type { RemoteStore } from './remote';
import type { Membership, SharingRemote } from './sharing';
import { membershipKey } from './sharing';
import type { SyncResult, RowScope } from './sync';
import { syncOnce } from './sync';
import type { MonotonicClock } from './syncClock';
import type { ShareLedger, SyncStateStore } from './syncState';

export interface SharingSync {
  readonly remote: SharingRemote;
  /** The cursor for one shared car, by `shareStateKey`. */
  readonly stateFor: (key: string) => SyncStateStore;
  readonly forgetState: (key: string) => Promise<void>;
  readonly ledger: ShareLedger;
}

export interface ShareOutcome {
  readonly synced: readonly Membership[];
  /** Shares that ended, and were forgotten on this device. */
  readonly ended: readonly Membership[];
  /** Shares that could not be reached this time; nothing was forgotten. */
  readonly failed: readonly Membership[];
  /** True when the membership list itself could not be read. */
  readonly unreachable: boolean;
  /**
   * New shares whose car id is already a car on this device (#78): not synced,
   * not recorded, nothing deleted. Leaving them resolves it.
   */
  readonly clashed: readonly Membership[];
}

export interface SyncAllResult {
  readonly own: SyncResult;
  readonly shares: ShareOutcome;
}

const NO_SHARES: ShareOutcome = { synced: [], ended: [], failed: [], unreachable: false, clashed: [] };

/** Said when the ledger cannot be read: a pause, not a refusal, so retried. */
export const LEDGER_UNREADABLE =
  'Could not read which cars are shared with you on this device, so nothing was synced. It will be tried again.';

export function shareStateKey(membership: Pick<Membership, 'ownerUid' | 'vehicleId'>): string {
  return `share:${membershipKey(membership)}`;
}

/** Every row except those of `sharedCars`: the account's own sync (step 1). */
export function excluding(sharedCars: ReadonlySet<string>): RowScope {
  return (collection, row) =>
    collection === 'vehicles' ? !sharedCars.has(row.id) : !sharedCars.has(row.vehicleId ?? '');
}

/** Only `vehicleId`'s fill-ups: one shared car's sync (step 2). */
export function onlyFillUpsOf(vehicleId: string): RowScope {
  return (collection, row) => collection === 'fillUps' && row.vehicleId === vehicleId;
}

export async function syncAll(
  store: FuelTrackerStore,
  own: RemoteStore,
  sharing: SharingSync | null,
  clock: MonotonicClock,
  ownState: SyncStateStore,
): Promise<SyncAllResult> {
  if (sharing === null) {
    return { own: await syncOnce(store, own, clock, ownState), shares: NO_SHARES };
  }

  let held: Membership[];
  try {
    held = await sharing.ledger.load();
  } catch {
    return { own: { ok: false, kind: 'unreachable', reason: LEDGER_UNREADABLE }, shares: NO_SHARES };
  }
  let current: Membership[] | null;
  try {
    current = await sharing.remote.memberships();
  } catch {
    current = null;
  }

  // A new share naming a car already on this device (#78). Checked before the
  // own sync, which must still leave that car out: whose it is, is unclear.
  const heldKeys = new Set(held.map(membershipKey));
  const clashed: Membership[] = [];
  const sharable: Membership[] = [];
  for (const membership of current ?? []) {
    const isNew = !heldKeys.has(membershipKey(membership));
    if (isNew && (await store.hasVehicle(membership.vehicleId))) clashed.push(membership);
    else sharable.push(membership);
  }

  // Excluded from the account's own push: every car held or currently shared.
  const sharedCars = new Set([...held, ...(current ?? [])].map((m) => m.vehicleId));
  const ownResult = await syncOnce(store, own, clock, ownState, { scope: excluding(sharedCars) });

  if (current === null) return { own: ownResult, shares: { ...NO_SHARES, unreachable: true } };
  // Not on the allowlist: the shared cars will refuse too, and saying so
  // once is the account's message to give.
  if (!ownResult.ok && ownResult.kind === 'refused') return { own: ownResult, shares: NO_SHARES };

  const ended: Membership[] = [];
  const synced: Membership[] = [];
  const failed: Membership[] = [];
  const currentKeys = new Set(current.map(membershipKey));

  // Recorded before anything is pulled, so the ledger is never behind what
  // this device holds. Ended shares stay in it until they are forgotten below.
  const recorded = [...held, ...sharable.filter((membership) => !heldKeys.has(membershipKey(membership)))];
  try {
    await sharing.ledger.save(recorded);
  } catch {
    return { own: ownResult, shares: { ...NO_SHARES, clashed, failed: [...sharable] } };
  }

  async function forget(membership: Membership): Promise<void> {
    await store.forgetVehicle(membership.vehicleId);
    await sharing!.forgetState(shareStateKey(membership));
    ended.push(membership);
  }

  // Left on another device, or removed and already cleaned up elsewhere.
  for (const membership of held) {
    if (!currentKeys.has(membershipKey(membership))) await forget(membership);
  }

  for (const membership of sharable) {
    const result = await syncOnce(
      store,
      sharing.remote.scoped(membership),
      clock,
      sharing.stateFor(shareStateKey(membership)),
      { scope: onlyFillUpsOf(membership.vehicleId) },
    );
    if (!result.ok && result.kind === 'refused') {
      // Removed by the owner: the rules say no. Tidy our own list too.
      await sharing.remote.leave(membership).catch(() => {});
      await forget(membership);
      continue;
    }
    if (!result.ok) {
      failed.push(membership);
      continue;
    }
    const car = (await store.exportSnapshot()).vehicles.find((v) => v.id === membership.vehicleId);
    if (car !== undefined && car.deletedAt !== null) {
      // The owner deleted the car. Nothing is left to share.
      await sharing.remote.leave(membership).catch(() => {});
      await forget(membership);
      continue;
    }
    synced.push(membership);
  }

  const endedKeys = new Set(ended.map(membershipKey));
  await sharing.ledger
    .save(sharable.filter((membership) => !endedKeys.has(membershipKey(membership))))
    .catch(() => {});

  return { own: ownResult, shares: { synced, ended, failed, unreachable: false, clashed } };
}
