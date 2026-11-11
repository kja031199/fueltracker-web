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

import type { SyncTarget } from './replica';
import type { RemoteStore } from './remote';
import type { Membership, SharingRemote } from './sharing';
import { membershipKey } from './sharing';
import type { SyncOutcome, SyncResult, RowScope } from './sync';
import { syncOnce } from './sync';
import { LocalView } from './localView';
import type { SyncStateStore } from './syncState';
import type { ShareLedger } from './shareLedger';

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
  /**
   * Shares whose upload the owner's account refused (#84): something about
   * the data, so trying again will not help, and it is not the network. Used
   * to be filed under `failed` and reported as "could not be reached".
   */
  readonly rejected: readonly Membership[];
  /**
   * What each share that synced reported (#84) — rows that were unusable,
   * photos too large to send, rows that cannot be sent — so they are told
   * like the account's own, not dropped.
   */
  readonly outcomes: readonly SyncOutcome[];
  /** True when the membership list itself could not be read. */
  readonly unreachable: boolean;
  /**
   * The cars shared with this account, as just read from it — `null` when
   * they were not (#89). The screens take their list from here rather than
   * reading it a second time after every sync.
   */
  readonly memberships: readonly Membership[] | null;
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

const NO_SHARES: ShareOutcome = {
  synced: [],
  ended: [],
  failed: [],
  rejected: [],
  outcomes: [],
  unreachable: false,
  memberships: null,
  clashed: [],
};

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
  store: SyncTarget,
  own: RemoteStore,
  sharing: SharingSync | null,
  ownState: SyncStateStore,
): Promise<SyncAllResult> {
  if (sharing === null) {
    return { own: await syncOnce(store, own, ownState), shares: NO_SHARES };
  }

  let held: Membership[];
  try {
    held = await sharing.ledger.load();
  } catch {
    // A pause to retry, not a refusal (#77): said in the screens' words (#91).
    return { own: { ok: false, kind: 'unreachable', problem: 'ledger-unreadable' }, shares: NO_SHARES };
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
    if (isNew && (await store.replica.hasVehicle(membership.vehicleId))) clashed.push(membership);
    else sharable.push(membership);
  }

  // Excluded from the account's own push: every car held or currently shared.
  const sharedCars = new Set([...held, ...(current ?? [])].map((m) => m.vehicleId));
  // One look at this device for the whole sync (#87), shared by every remote.
  // The text repair runs once, here, over every row — shared cars' included.
  const local = new LocalView(store.replica);
  const ownResult = await syncOnce(store, own, ownState, { scope: excluding(sharedCars), local });

  if (current === null) return { own: ownResult, shares: { ...NO_SHARES, unreachable: true } };
  // Not on the allowlist: the shared cars will refuse too, and saying so
  // once is the account's message to give.
  if (!ownResult.ok && ownResult.kind === 'refused') return { own: ownResult, shares: NO_SHARES };

  const ended: Membership[] = [];
  const synced: Membership[] = [];
  const failed: Membership[] = [];
  const rejected: Membership[] = [];
  const outcomes: SyncOutcome[] = [];
  const currentKeys = new Set(current.map(membershipKey));

  // Recorded before anything is pulled, so the ledger is never behind what
  // this device holds. Ended shares stay in it until they are forgotten below.
  const recorded = [...held, ...sharable.filter((membership) => !heldKeys.has(membershipKey(membership)))];
  try {
    await sharing.ledger.save(recorded);
  } catch {
    return { own: ownResult, shares: { ...NO_SHARES, clashed, failed: [...sharable], memberships: current } };
  }

  async function forget(membership: Membership): Promise<void> {
    await store.replica.forgetVehicle(membership.vehicleId);
    await local.forgetVehicle(membership.vehicleId);
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
      sharing.stateFor(shareStateKey(membership)),
      { scope: onlyFillUpsOf(membership.vehicleId), local, repair: false },
    );
    if (!result.ok && result.kind === 'refused') {
      // Removed by the owner: the rules say no. Tidy our own list too.
      await sharing.remote.leave(membership).catch(() => {});
      await forget(membership);
      continue;
    }
    if (!result.ok) {
      // The pull worked and the owner's account refused the upload: about the
      // data, and said so (#84). Anything else is the network.
      (result.kind === 'rejected' ? rejected : failed).push(membership);
      continue;
    }
    outcomes.push(result.outcome);
    const car = await local.vehicle(membership.vehicleId);
    if (car !== undefined && car.deletedAt !== null) {
      // The owner deleted the car. Nothing is left to share.
      await sharing.remote.leave(membership).catch(() => {});
      await forget(membership);
      continue;
    }
    synced.push(membership);
  }

  const endedKeys = new Set(ended.map(membershipKey));
  await sharing.ledger.save(sharable.filter((membership) => !endedKeys.has(membershipKey(membership)))).catch(() => {});

  return {
    own: ownResult,
    shares: { ...NO_SHARES, synced, ended, failed, rejected, outcomes, clashed, memberships: current },
  };
}
