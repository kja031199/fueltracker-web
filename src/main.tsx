/**
 * Where the real implementations get wired in.
 *
 * The only file that knows both that Firebase exists and that the app exists.
 * Everything above it talks to `AuthProvider` and `RemoteStore`, which is what
 * keeps the test suite free of network code — see the header of `data/auth.ts`.
 *
 * ## What loads when is `bootstrap.ts`
 *
 * The shell renders at once, auth loads next, and the Firestore modules only
 * on sign-in (#90); the database is opened only once the account is known.
 * `boot` takes the loaders as arguments so that order is tested; this file
 * hands it the real ones.
 *
 * ## A missing config is a supported state
 *
 * A checkout with no `.env.local` still builds, starts and runs its tests; it
 * just cannot sign in, and says so on screen instead of throwing during module
 * evaluation. A config read that throws on import gives a blank page and a
 * console message, which is the least diagnosable failure there is.
 *
 * ## A development build refuses the production project
 *
 * Issue #45. Checked before Firebase is even imported, so a dev server whose
 * `.env.local` names production opens no auth session, no database and no
 * connection — it renders `WrongProjectScreen` and stops. See
 * `developmentUsesProduction` for the two signals and why there is no override.
 */

import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App } from './ui/App';
import { openSignedInAccount } from './data/accountStore';
import { StubAuthProvider } from './data/auth';
import { developmentUsesProduction, readSettings } from './data/firebase/settings';
import { boot, emptyStore, type AppProps, type RemoteFactory } from './bootstrap';
import { installCspWatch } from './ui/cspWatch';
import { releaseReader } from './ui/ocr';
import { WrongProjectScreen } from './ui/WrongProjectScreen';
import { ScreenFrame } from './ui/ScreenFrame';
import './ui/styles.css';

// Before anything renders, so a violation during load is caught. Records
// nothing unless somebody armed it from the console — see cspWatch.ts and
// docs/csp-check.md.
installCspWatch();

const container = document.getElementById('root');
if (container === null) throw new Error('missing #root');
const root: Root = createRoot(container);

function renderApp({ auth, store, remote, configured, syncState, sharing }: AppProps): void {
  root.render(
    <StrictMode>
      <App
        store={store}
        auth={auth}
        remote={remote}
        configured={configured}
        {...(syncState === undefined ? {} : { syncState })}
        {...(sharing === undefined ? {} : { sharing })}
      />
    </StrictMode>,
  );
}

function renderOpening(): void {
  root.render(
    <ScreenFrame>
      <p className="empty">Opening your fuel log…</p>
    </ScreenFrame>,
  );
}

function start(): void {
  const settings = readSettings(import.meta.env as unknown as Record<string, string | undefined>);

  if (settings === null) {
    // No backend in this build. Render the sign-in screen in its unconfigured
    // state, which explains what to do, rather than a dead button.
    renderApp({
      auth: new StubAuthProvider({ status: 'signedOut', error: null }),
      store: emptyStore(),
      remote: null,
      configured: false,
    });
    return;
  }

  if (
    developmentUsesProduction(settings, {
      dev: import.meta.env.DEV,
      hostname: window.location.hostname,
    })
  ) {
    root.render(<WrongProjectScreen projectId={settings.projectId.trim()} />);
    return;
  }

  // Bound after the null check so the narrowing survives into the closures.
  const config = settings;

  // Each module is imported lazily, so the Firebase SDK stays out of the
  // initial chunk — and the Firestore one out of the sign-in screen's path.
  void boot({
    loadAuth: async () => {
      const { FirebaseAuthProvider } = await import('./data/firebase/authProvider');
      return new FirebaseAuthProvider(config);
    },
    loadRemotes: async (): Promise<RemoteFactory> => {
      const [{ FirestoreRemoteStore }, { FirestoreSharingRemote }] = await Promise.all([
        import('./data/firebase/remoteStore'),
        import('./data/firebase/sharingRemote'),
      ]);
      return (uid, user) => ({
        remote: new FirestoreRemoteStore(config, uid),
        sharingRemote: FirestoreSharingRemote.forAccount(config, {
          uid,
          name: user.displayName,
          email: user.email,
          emailVerified: user.emailVerified === true,
        }),
      });
    },
    openAccount: openSignedInAccount,
    view: { opening: renderOpening, app: renderApp },
    // The receipt reader holds the last photo's pixels; it goes with the session.
    onAccountClosed: () => {
      void releaseReader();
    },
  });
}

start();
