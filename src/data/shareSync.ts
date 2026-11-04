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
}

export interface SyncAllResult {
  readonly own: SyncResult;
  readonly shares: ShareOutcome;
}

const NO_SHARES: ShareOutcome = { synced: [], ended: [], failed: [], unreachable: false };

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

  const held = await sharing.ledger.load().catch(() => [] as Membership[]);
  let current: Membership[] | null;
  try {
    current = await sharing.remote.memberships();
  } catch {
    current = null;
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

  async function forget(membership: Membership): Promise<void> {
    await store.forgetVehicle(membership.vehicleId);
    await sharing!.forgetState(shareStateKey(membership));
    ended.push(membership);
  }

  // Left on another device, or removed and already cleaned up elsewhere.
  for (const membership of held) {
    if (!currentKeys.has(membershipKey(membership))) await forget(membership);
  }

  for (const membership of current) {
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
    .save(current.filter((membership) => !endedKeys.has(membershipKey(membership))))
    .catch(() => {});

  return { own: ownResult, shares: { synced, ended, failed, unreachable: false } };
}
