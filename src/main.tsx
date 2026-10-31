/**
 * Where the real implementations get wired in.
 *
 * The only file that knows both that Firebase exists and that the app exists.
 * Everything above it talks to `AuthProvider` and `RemoteStore`, which is what
 * keeps the test suite free of network code — see the header of `data/auth.ts`.
 *
 * ## The store is opened *after* the account is known
 *
 * It used to be a module constant, which is how local data came to be shared
 * between everyone who signed in on a device — the leak described at length in
 * `data/accountStore.ts`. The database is now named after the uid, so it cannot
 * be opened until auth has resolved, and it is closed and reopened when the
 * signed-in account changes.
 *
 * ## A missing config is a supported state
 *
 * A checkout with no `.env.local` still builds, starts and runs its tests; it
 * just cannot sign in, and says so on screen instead of throwing during module
 * evaluation. A config read that throws on import gives a blank page and a
 * console message, which is the least diagnosable failure there is.
 */

import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App } from './ui/App';
import { InMemoryRepository } from './data/repository';
import type { FillUpRecord, PendingFillUpRecord, VehicleRecord } from './data/records';
import { FuelTrackerStore } from './data/store';
import type { AccountStore } from './data/accountStore';
import { adoptLegacyDatabase, openAccountStore } from './data/accountStore';
import type { AuthProvider, AuthState } from './data/auth';
import { StubAuthProvider } from './data/auth';
import type { RemoteStore } from './data/remote';
import { readSettings } from './data/firebase/settings';
import './ui/styles.css';

const container = document.getElementById('root');
if (container === null) throw new Error('missing #root');
const root: Root = createRoot(container);

/**
 * A store backed by nothing, for the signed-out render.
 *
 * `App` gates on auth before showing any data, but `useAppData` still mounts
 * and reads once. Handing it an empty in-memory store keeps that read harmless
 * and — the point — means **no IndexedDB database is opened before we know
 * whose it is**.
 */
function emptyStore(): FuelTrackerStore {
  return new FuelTrackerStore({
    vehicles: new InMemoryRepository<VehicleRecord>(),
    fillUps: new InMemoryRepository<FillUpRecord>(),
    pendingFillUps: new InMemoryRepository<PendingFillUpRecord>(),
  });
}

function render(
  auth: AuthProvider,
  store: FuelTrackerStore,
  remote: RemoteStore | null,
  configured: boolean,
): void {
  root.render(
    <StrictMode>
      <App store={store} auth={auth} remote={remote} configured={configured} />
    </StrictMode>,
  );
}

function renderOpening(): void {
  root.render(
    <div className="app">
      <p className="empty">Opening your fuel log…</p>
    </div>,
  );
}

async function start(): Promise<void> {
  const settings = readSettings(import.meta.env as unknown as Record<string, string | undefined>);

  if (settings === null) {
    // No backend in this build. Render the sign-in screen in its unconfigured
    // state, which explains what to do, rather than a dead button.
    render(new StubAuthProvider({ status: 'signedOut', error: null }), emptyStore(), null, false);
    return;
  }

  // Bound after the null check so the narrowing survives into `apply` below,
  // which is a closure created before it runs.
  const config = settings;

  // Imported lazily so the Firebase SDK stays out of the initial chunk.
  const [{ FirebaseAuthProvider }, { FirestoreRemoteStore }] = await Promise.all([
    import('./data/firebase/authProvider'),
    import('./data/firebase/remoteStore'),
  ]);

  const auth = new FirebaseAuthProvider(config);

  // Both stores are cached per uid. `onAuthStateChanged` fires on token refresh
  // as well as on sign-in, and rebuilding them each time would reopen the
  // database and hand React new prop identities, which would refire the sync
  // effect and spend quota re-reading the account for nothing.
  let open: { readonly uid: string; readonly account: AccountStore; readonly remote: RemoteStore } | null =
    null;
  // Guards against two auth events being handled concurrently: opening a
  // database is asynchronous, and the later event must win.
  let generation = 0;

  async function apply(state: AuthState): Promise<void> {
    const mine = ++generation;

    if (state.status !== 'signedIn') {
      open?.account.close();
      open = null;
      render(auth, emptyStore(), null, true);
      return;
    }

    const { uid } = state.user;
    if (open?.uid === uid) {
      render(auth, open.account.store, open.remote, true);
      return;
    }

    open?.account.close();
    open = null;
    renderOpening();

    // One-time rescue of data written before accounts existed. Declines of its
    // own accord if there is nothing to adopt, if the account already has rows,
    // or if it has already run — see `adoptLegacyDatabase`.
    await adoptLegacyDatabase(uid);
    const account = await openAccountStore(uid);

    if (mine !== generation) {
      // Another auth event overtook this one while the database was opening.
      account.close();
      return;
    }

    open = { uid, account, remote: new FirestoreRemoteStore(config, uid) };
    render(auth, account.store, open.remote, true);
  }

  auth.subscribe((state: AuthState) => {
    void apply(state);
  });
}

void start();
