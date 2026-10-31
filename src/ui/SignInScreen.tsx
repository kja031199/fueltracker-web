/**
 * The front door.
 *
 * Sign-in is required, so this is the first thing a new reader sees — and it is
 * the one screen that has to be honest about a trade the app now makes. The
 * previous version stored everything in the browser and uploaded nothing; this
 * one keeps a copy in the reader's Google account so it survives a cleared
 * cache and follows them to another device. Saying so here, rather than in a
 * privacy page nobody opens, is the least that owes them.
 *
 * Deliberately one button and no "continue without an account" escape hatch:
 * offering a local-only path that silently stops syncing is how someone ends up
 * believing their data is backed up when it is not.
 */

import type { ReactElement } from 'react';
import { useState } from 'react';
import type { AuthProvider } from '../data/auth';

interface Props {
  readonly auth: AuthProvider;
  /** Set when the previous attempt failed, so the reason stays on screen. */
  readonly error: string | null;
  /** False when no Firebase config is present in this build. */
  readonly configured?: boolean;
}

export function SignInScreen({ auth, error, configured = true }: Props): ReactElement {
  const [busy, setBusy] = useState(false);

  async function signIn(): Promise<void> {
    setBusy(true);
    try {
      await auth.signIn();
    } finally {
      // Always clears, including on the cancelled-popup path — otherwise the
      // button stays dead and the only way back is a reload.
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <main className="app__main">
        <h1 className="app__title">FuelTracker</h1>
        <section className="card" aria-labelledby="signin-heading">
          <h2 className="card__title" id="signin-heading">
            Sign in to continue
          </h2>
          <p style={{ margin: '0 0 8px' }}>
            Log every fill-up and this works out your real fuel economy, what you actually spend,
            and which day of the week you tend to catch the cheapest price.
          </p>
          <p style={{ margin: '0 0 12px' }}>
            Signing in with Google keeps your fuel log in your own account, so it survives clearing
            your browser data and follows you to your phone. Your fill-ups are readable only by
            you.
          </p>

          {configured ? (
            <button className="button" type="button" onClick={signIn} disabled={busy}>
              {busy ? 'Signing in…' : 'Continue with Google'}
            </button>
          ) : (
            <p className="warning" style={{ margin: 0 }}>
              This build has no Firebase configuration, so signing in is not possible. Copy
              <code> .env.example </code>
              to <code>.env.local</code>, fill in the project values, and restart the dev server.
            </p>
          )}

          {error !== null && (
            <p className="warning" style={{ margin: '12px 0 0' }} role="alert">
              {error}
            </p>
          )}

          <p style={{ margin: '12px 0 0', opacity: 0.8 }}>
            The first sign-in on a device needs a connection. After that the app opens and works
            offline, and syncs again when you are back.
          </p>
        </section>
      </main>
    </div>
  );
}
