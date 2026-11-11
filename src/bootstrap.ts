/**
 * Starting the app once Firebase is configured: what loads when, and which
 * account's data is open (#90).
 *
 * ## The first paint does not wait for Firebase
 *
 * `main.tsx` used to await the auth, Firestore and sharing modules together
 * before rendering anything — so every cold start, the sign-in screen included,
 * showed a blank page while about 170 KB gzipped of Firebase downloaded,
 * parsed and ran, though the Firestore modules (about 140 KB of that) are only
 * *used* once somebody is signed in. Now:
 *
 * 1. a shell renders at once;
 * 2. the auth module loads (about 21 KB gzipped), and the sign-in screen can
 *    render as soon as auth knows nobody is signed in;
 * 3. the Firestore modules load only on sign-in — alongside opening the
 *    account's database, so a returning reader waits no longer than before.
 *
 * If they cannot load (offline on a first visit, before the service worker
 * cached them), the log opens locally, without sync — the same state as a
 * build with no remote — and the next auth event tries again.
 *
 * ## The store is opened *after* the account is known
 *
 * The database is named after the uid, so it cannot be opened until auth has
 * resolved, and it is closed and reopened when the signed-in account changes —
 * see `data/accountStore.ts`. Both stores are cached per uid:
 * `onAuthStateChanged` fires on token refresh as well as on sign-in, and
 * rebuilding them each time would reopen the database and hand React new prop
 * identities, refiring the sync effect for nothing.
 *
 * Everything that loads or renders is passed in, so the order is tested
 * without a browser (`bootstrap.test.ts`). `main.tsx` supplies the real ones.
 */

import type { AccountStore } from './data/accountStore';
import type { AuthProvider, AuthState, AuthUser } from './data/auth';
import type { RemoteStore } from './data/remote';
import { InMemoryRepository } from './data/repository';
import type { FillUpRecord, PendingFillUpRecord, VehicleRecord } from './data/records';
import type { SharingRemote } from './data/sharing';
import type { SharingSync } from './data/shareSync';
import { FuelTrackerStore } from './data/store';
import type { SyncStateStore } from './data/syncState';

/** What `App` is rendered with. */
export interface AppProps {
  readonly auth: AuthProvider;
  readonly store: FuelTrackerStore;
  readonly remote: RemoteStore | null;
  readonly configured: boolean;
  readonly syncState?: SyncStateStore;
  readonly sharing?: SharingSync;
}

/** Makes one account's remotes, once the Firestore modules have loaded. */
export type RemoteFactory = (
  uid: string,
  user: AuthUser,
) => { readonly remote: RemoteStore; readonly sharingRemote: SharingRemote };

export interface BootDeps {
  /** Loads the auth module and makes the provider. */
  readonly loadAuth: () => Promise<AuthProvider>;
  /** Loads the Firestore modules. Called only once somebody is signed in. */
  readonly loadRemotes: () => Promise<RemoteFactory>;
  /** Opens a signed-in account's database. */
  openAccount: (uid: string) => Promise<AccountStore>;
  readonly view: {
    /** The shell shown while something loads or opens. */
    readonly opening: () => void;
    readonly app: (props: AppProps) => void;
  };
  /**
   * The open account was closed — signed out, or another signed in. What the
   * session held beyond the database goes with it (the receipt reader).
   */
  readonly onAccountClosed?: () => void;
}

/**
 * A store backed by nothing, for the signed-out render.
 *
 * `App` gates on auth before showing any data, but `useAppData` still mounts
 * and reads once. Handing it an empty in-memory store keeps that read harmless
 * and — the point — means **no IndexedDB database is opened before we know
 * whose it is**.
 */
export function emptyStore(): FuelTrackerStore {
  return new FuelTrackerStore({
    vehicles: new InMemoryRepository<VehicleRecord>(),
    fillUps: new InMemoryRepository<FillUpRecord>(),
    pendingFillUps: new InMemoryRepository<PendingFillUpRecord>(),
  });
}

export async function boot(deps: BootDeps): Promise<void> {
  deps.view.opening();
  const auth = await deps.loadAuth();

  // Loaded once and remembered; a failed load is forgotten so the next
  // sign-in or token refresh tries again.
  let remotes: Promise<RemoteFactory> | null = null;
  function loadRemotes(): Promise<RemoteFactory> {
    if (remotes === null) {
      const loading = deps.loadRemotes();
      remotes = loading;
      loading.catch(() => {
        if (remotes === loading) remotes = null;
      });
    }
    return remotes;
  }

  let open: {
    readonly uid: string;
    readonly account: AccountStore;
    readonly remote: RemoteStore | null;
    /** Cars shared with and by this account (#66); none without a remote. */
    readonly sharing: SharingSync | undefined;
  } | null = null;
  // Guards against two auth events being handled concurrently: opening a
  // database is asynchronous, and the later event must win.
  let generation = 0;

  function show(account: AccountStore, remote: RemoteStore | null, sharing: SharingSync | undefined): void {
    deps.view.app({
      auth,
      store: account.store,
      remote,
      configured: true,
      syncState: account.syncState,
      ...(sharing === undefined ? {} : { sharing }),
    });
  }

  function close(): void {
    if (open === null) return;
    open.account.close();
    open = null;
    deps.onAccountClosed?.();
  }

  async function apply(state: AuthState): Promise<void> {
    const mine = ++generation;

    if (state.status !== 'signedIn') {
      close();
      deps.view.app({ auth, store: emptyStore(), remote: null, configured: true });
      return;
    }

    const { uid } = state.user;
    // Same account, and it has its sync: a token refresh. Reuse everything. One
    // opened without sync, because the modules would not load, is reopened so
    // they are tried again.
    if (open?.uid === uid && open.remote !== null) {
      show(open.account, open.remote, open.sharing);
      return;
    }

    close();
    deps.view.opening();

    const [account, factory] = await Promise.all([deps.openAccount(uid), loadRemotes().catch(() => null)]);

    if (mine !== generation) {
      // Another auth event overtook this one while the database was opening.
      account.close();
      return;
    }

    const made = factory === null ? null : factory(uid, state.user);
    const sharing = made === null ? undefined : { ...account.sharingState, remote: made.sharingRemote };
    open = { uid, account, remote: made?.remote ?? null, sharing };
    show(account, open.remote, sharing);
  }

  auth.subscribe((state: AuthState) => {
    void apply(state);
  });
}
