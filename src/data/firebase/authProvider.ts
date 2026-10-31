/**
 * Google sign-in, via Firebase Auth.
 *
 * The **only** file in the repository that imports `firebase/auth`. Nothing in
 * the test suite imports this one, which is what keeps 598 assertions running
 * with no network — see the header of `data/auth.ts` for why that separation is
 * load-bearing rather than tidy.
 *
 * ## Persistence is the whole reason sign-in can be required
 *
 * `browserLocalPersistence` keeps the session in IndexedDB, so a reload — and
 * critically, a reload with **no network at all** — restores the signed-in user
 * without contacting Google. That is what makes a required sign-in compatible
 * with an offline-first app: the gate is passed from local state, and only the
 * *first* sign-in on a device needs connectivity.
 *
 * The restore is asynchronous, which is why `AuthState` has a `loading` case.
 */

import {
  GoogleAuthProvider,
  browserLocalPersistence,
  getAuth,
  onAuthStateChanged,
  setPersistence,
  signInWithPopup,
  signOut as firebaseSignOut,
  type Auth,
  type User,
} from 'firebase/auth';
import type { AuthProvider, AuthState, AuthUser } from '../auth';
import { firebaseApp, type FirebaseSettings } from './config';

function toUser(user: User): AuthUser {
  return {
    uid: user.uid,
    email: user.email ?? '',
    displayName: user.displayName ?? '',
  };
}

/**
 * Turns a Firebase error code into something worth reading on screen.
 *
 * The raw codes leak through to users otherwise, and two of these are things
 * the person can actually act on rather than faults in the app.
 */
function explain(cause: unknown): string {
  const code = typeof cause === 'object' && cause !== null && 'code' in cause
    ? String((cause as { code: unknown }).code)
    : '';
  switch (code) {
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
      return 'Sign-in was cancelled.';
    case 'auth/popup-blocked':
      return 'Your browser blocked the sign-in window. Allow pop-ups for this site and try again.';
    case 'auth/network-request-failed':
      return 'No connection. Signing in for the first time on a device needs the network.';
    case 'auth/unauthorized-domain':
      return 'This address is not an authorized domain in the Firebase project.';
    default:
      return cause instanceof Error && cause.message !== ''
        ? `Sign-in failed. (${cause.message})`
        : 'Sign-in failed.';
  }
}

export class FirebaseAuthProvider implements AuthProvider {
  private readonly auth: Auth;
  private currentState: AuthState = { status: 'loading' };
  private readonly listeners = new Set<(state: AuthState) => void>();

  constructor(settings: FirebaseSettings) {
    this.auth = getAuth(firebaseApp(settings));
    // Fire-and-forget: the default is already local persistence in a browser,
    // so a failure here (private mode with storage blocked) degrades to a
    // session that does not survive a reload rather than no sign-in at all.
    void setPersistence(this.auth, browserLocalPersistence).catch(() => undefined);
    onAuthStateChanged(this.auth, (user) => {
      this.set(
        user === null ? { status: 'signedOut', error: null } : { status: 'signedIn', user: toUser(user) },
      );
    });
  }

  state(): AuthState {
    return this.currentState;
  }

  subscribe(listener: (state: AuthState) => void): () => void {
    this.listeners.add(listener);
    listener(this.currentState);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async signIn(): Promise<void> {
    const provider = new GoogleAuthProvider();
    // Always ask which account. Without this, a shared machine silently reuses
    // whoever signed in last, and the second person's fill-ups land in the
    // first person's log.
    provider.setCustomParameters({ prompt: 'select_account' });
    try {
      await signInWithPopup(this.auth, provider);
    } catch (cause) {
      this.set({ status: 'signedOut', error: explain(cause) });
    }
  }

  async signOut(): Promise<void> {
    await firebaseSignOut(this.auth);
  }

  private set(next: AuthState): void {
    this.currentState = next;
    for (const listener of this.listeners) listener(next);
  }
}
