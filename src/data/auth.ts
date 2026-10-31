/**
 * Who is signed in, behind an interface.
 *
 * ## Why this is an interface and not just the Firebase SDK
 *
 * The iOS original paid for this lesson once already. `AppLock` called
 * `LAContext` directly, so every view-rendering test turned into a round-trip
 * to a system daemon on a headless simulator — and a twenty-minute "slow build"
 * turned out to be that call hanging, not the compiler. The fix there was a
 * `DeviceAuthenticating` protocol with a stub; this is the same shape for the
 * same reason. `FirebaseAuthProvider` is the only file in the repository that
 * imports `firebase/auth`, and no test imports it, so the suite still runs with
 * no network and no emulator.
 *
 * ## Why a three-state machine rather than `user | null`
 *
 * Firebase restores a persisted session **asynchronously**. A gate written
 * against `user === null` therefore renders the sign-in screen for a fraction of
 * a second to someone who is already signed in, on every single load. Worse, it
 * would do it offline too — where the restore still succeeds from IndexedDB but
 * the flash looks exactly like being signed out.
 *
 * So `loading` is a state of its own, and the gate waits for it to resolve.
 */

export interface AuthUser {
  readonly uid: string;
  readonly email: string;
  readonly displayName: string;
}

export type AuthState =
  /** The persisted session has not been restored yet. Render nothing decisive. */
  | { readonly status: 'loading' }
  | { readonly status: 'signedOut'; readonly error: string | null }
  | { readonly status: 'signedIn'; readonly user: AuthUser };

export interface AuthProvider {
  /** The current state, synchronously. */
  state(): AuthState;
  /**
   * Subscribes to state changes and **calls the listener immediately** with the
   * current state, so a subscriber never has to read `state()` separately and
   * race with the first change.
   *
   * Returns an unsubscribe function.
   */
  subscribe(listener: (state: AuthState) => void): () => void;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
}

/**
 * An `AuthProvider` backed by nothing at all.
 *
 * Used by every test and by the component suites. `signIn()` resolves to a
 * fixed user rather than contacting anything, which is what makes a rendering
 * test of a signed-in app possible without a network stack.
 */
export class StubAuthProvider implements AuthProvider {
  private currentState: AuthState;
  private readonly listeners = new Set<(state: AuthState) => void>();

  constructor(
    initial: AuthState = { status: 'signedOut', error: null },
    private readonly user: AuthUser = {
      uid: 'test-uid',
      email: 'driver@example.com',
      displayName: 'Test Driver',
    },
    /** Set to make `signIn()` reject, for the failure path. */
    private readonly signInError: string | null = null,
  ) {
    this.currentState = initial;
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
    if (this.signInError !== null) {
      this.set({ status: 'signedOut', error: this.signInError });
      return;
    }
    this.set({ status: 'signedIn', user: this.user });
  }

  async signOut(): Promise<void> {
    this.set({ status: 'signedOut', error: null });
  }

  /** Test helper: drives a state change from outside, as Firebase would. */
  set(next: AuthState): void {
    this.currentState = next;
    for (const listener of this.listeners) listener(next);
  }
}
