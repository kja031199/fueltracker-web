/**
 * Where the real implementations get wired in.
 *
 * The only file that knows both that Firebase exists and that the app exists.
 * Everything above it talks to `AuthProvider` and `RemoteStore`, which is what
 * keeps the test suite free of network code — see the header of `data/auth.ts`.
 *
 * ## A missing config is a supported state
 *
 * A checkout with no `.env.local` still builds, starts and runs its tests; it
 * just cannot sign in, and says so on screen instead of throwing during module
 * evaluation. A config read that throws on import gives a blank page and a
 * console message, which is the least diagnosable failure there is.
 *
 * ## Why the remote store is rebuilt on every auth change
 *
 * `FirestoreRemoteStore` is constructed with a uid and writes under
 * `users/{uid}`. Holding one instance across a sign-out would leave a store
 * pointed at the previous person's documents, so it is created from the
 * signed-in user and discarded with them.
 */

import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App } from './ui/App';
import { DexieRepository, FuelTrackerDatabase } from './data/db';
import { FuelTrackerStore } from './data/store';
import type { AuthProvider, AuthState } from './data/auth';
import { StubAuthProvider } from './data/auth';
import type { RemoteStore } from './data/remote';
import { readSettings } from './data/firebase/settings';
import './ui/styles.css';

const db = new FuelTrackerDatabase();
const store = new FuelTrackerStore({
  vehicles: new DexieRepository(db.vehicles),
  fillUps: new DexieRepository(db.fillUps),
  pendingFillUps: new DexieRepository(db.pendingFillUps),
});

const container = document.getElementById('root');
if (container === null) throw new Error('missing #root');
const root: Root = createRoot(container);

function render(auth: AuthProvider, remote: RemoteStore | null, configured: boolean): void {
  root.render(
    <StrictMode>
      <App store={store} auth={auth} remote={remote} configured={configured} />
    </StrictMode>,
  );
}

async function start(): Promise<void> {
  const settings = readSettings(import.meta.env as unknown as Record<string, string | undefined>);

  if (settings === null) {
    // No backend in this build. Render the sign-in screen in its unconfigured
    // state, which explains what to do, rather than a dead button.
    render(new StubAuthProvider({ status: 'signedOut', error: null }), null, false);
    return;
  }

  // Imported lazily so the Firebase SDK stays out of the initial chunk.
  const [{ FirebaseAuthProvider }, { FirestoreRemoteStore }] = await Promise.all([
    import('./data/firebase/authProvider'),
    import('./data/firebase/remoteStore'),
  ]);

  const auth = new FirebaseAuthProvider(settings);

  // Cached per uid rather than rebuilt on every auth event. `onAuthStateChanged`
  // fires on token refresh as well as on sign-in, and a fresh store object each
  // time is a new prop identity, which would make the sync effect refire and
  // spend quota re-reading the account for no reason. Keyed by uid so a sign-out
  // and sign-in as someone else still gets its own store, never the previous
  // person's documents.
  let cached: { readonly uid: string; readonly store: RemoteStore } | null = null;

  auth.subscribe((state: AuthState) => {
    if (state.status !== 'signedIn') {
      cached = null;
      render(auth, null, true);
      return;
    }
    const { uid } = state.user;
    if (cached?.uid !== uid) {
      cached = { uid, store: new FirestoreRemoteStore(settings, uid) };
    }
    render(auth, cached.store, true);
  });
}

void start();
