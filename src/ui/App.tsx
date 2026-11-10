import type { ReactElement } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FuelTrackerStore } from '../data/store';
import type { AuthProvider } from '../data/auth';
import { StubAuthProvider } from '../data/auth';
import type { RemoteStore } from '../data/remote';
import type { SyncStateStore } from '../data/syncState';
import type { SharingSync } from '../data/shareSync';
import type { SchedulerTimers } from './syncScheduler';
import type { UnitPreferences } from '../domain/units';
import { clearActivity, forgetIdleTimeoutSetting, useIdleTimeout } from './idleTimeout';
import { ADMIN_IDLE_MINUTES } from './adminSettings';
import { applyPalette, preferredColorScheme, watchColorScheme } from './theme';
import { loadCurrency, loadUnitPreferences, saveCurrency, saveUnitPreferences } from './unitSettings';
import { displayLocale, type DisplayStyle } from '../domain/format';
import { useAuth } from './useAuth';
import { FuelLogProvider } from './fuelLog';
import { AppShell } from './AppShell';
import { DisplayProvider, SessionProvider, UnitsProvider } from './session';
import type { Tab } from './useTabRoute';
import { ScreenFrame } from './ScreenFrame';
import { SignInScreen } from './SignInScreen';

/**
 * The composition root (#56): **auth → this browser's preferences → the fuel
 * log → the screens.**
 *
 * - `App` gates on auth and holds what belongs to the browser — units, the
 *   palette — and enforces the administrator's idle sign-out (#70). It is one of two components allowed to name the
 *   store, and only hands it to the provider.
 * - `FuelLogProvider` owns the data, sync, and every write (`fuelLog.tsx`).
 * - `AppShell` is the signed-in app: account-scoped state (onboarding, the
 *   backup reminder), the route in the URL hash (`useRoute`) — a tab, or a
 *   fill-up link (#3) — and the screens.
 */

/**
 * A signed-in stub, used when no provider is passed.
 *
 * This mirrors the iOS render harness, which defaults to
 * `StubAuthenticator(canAuthenticate: true, result: true)` for the same reason:
 * so a test about the dashboard is a test about the dashboard, not about
 * authentication. `main.tsx` always passes the real provider, and a test that
 * cares about the gate passes its own stub in whichever state it wants.
 */
function defaultAuth(): AuthProvider {
  return new StubAuthProvider({
    status: 'signedIn',
    user: { uid: 'local', email: '', displayName: '' },
  });
}

export interface AppProps {
  readonly store: FuelTrackerStore;
  /** Test seam: which tab the app opens on. */
  readonly initialTab?: Tab;
  /** Omitted in tests, where it defaults to a signed-in stub. */
  readonly auth?: AuthProvider;
  /**
   * The account's copy of the data, or `null` for a build with no Firebase
   * configuration — in which case the app is local-only and says so.
   */
  readonly remote?: RemoteStore | null;
  /** False when this build has no Firebase config, so sign-in cannot work. */
  readonly configured?: boolean;
  /**
   * Where incremental sync keeps its place: the signed-in account's database
   * (#52). Omitted in tests, which get an in-memory one.
   */
  readonly syncState?: SyncStateStore;
  /**
   * Minutes of inactivity before signing out. The administrator's value
   * (`VITE_IDLE_TIMEOUT_MINUTES`, #70) unless a test pins another; never
   * anything the reader chose.
   */
  readonly idleMinutes?: number;
  /**
   * Cars shared with and by this account (#66): the Firestore sharing remote
   * plus this account's per-car cursors. Omitted in tests that are not about
   * sharing, and wherever nothing syncs.
   */
  readonly sharing?: SharingSync | null;
  /** Test seam (#97): the sync scheduler's timers, so a test fires the save-sync itself. */
  readonly syncTimers?: SchedulerTimers;
}

export function App({
  store,
  initialTab = 'dashboard',
  auth,
  remote = null,
  configured = true,
  syncState,
  idleMinutes = ADMIN_IDLE_MINUTES,
  sharing = null,
  syncTimers,
}: AppProps): ReactElement {
  // Memoised, or a new stub on every render would resubscribe forever.
  const authProvider = useMemo(() => auth ?? defaultAuth(), [auth]);
  const authState = useAuth(authProvider);
  const [units, setUnits] = useState<UnitPreferences>(() => loadUnitPreferences());
  // One locale for numbers and dates, the browser's; the currency follows it
  // unless picked in Settings (#94). Display only: nothing stored changes.
  const [locale] = useState(() => displayLocale(typeof navigator === 'undefined' ? undefined : navigator.language));
  const [currencyCode, setCurrencyCode] = useState(() => loadCurrency(locale));
  const style = useMemo<DisplayStyle>(() => ({ locale, currency: currencyCode }), [locale, currencyCode]);
  const [idleSignOut, setIdleSignOut] = useState(false);

  const signedIn = authState.status === 'signedIn';
  const endIdleSession = useCallback(() => {
    // The marker is cleared so the next session starts its own clock rather
    // than inheriting an already-expired one and bouncing straight back out.
    clearActivity();
    setIdleSignOut(true);
    void authProvider.signOut();
  }, [authProvider]);
  // Armed only while signed in: there is nothing to end otherwise, and arming
  // it on the sign-in screen would sign out the person trying to sign in.
  useIdleTimeout(signedIn ? idleMinutes : null, endIdleSession);

  // The per-browser on/off choice from before #70 is deleted, never read, so
  // an old "off" cannot opt this browser out of the administrator's timeout.
  useEffect(() => {
    forgetIdleTimeoutSetting();
  }, []);

  // The palette is applied from the ported values rather than written as CSS,
  // so what the browser paints is what the contrast tests measure.
  useEffect(() => {
    const root = document.documentElement;
    applyPalette(preferredColorScheme(), root);
    return watchColorScheme((scheme) => applyPalette(scheme, root));
  }, []);

  // Stable, so the units context changes only when the units do.
  const changeUnits = useCallback((next: UnitPreferences): void => {
    setUnits(next);
    saveUnitPreferences(next);
  }, []);
  const changeCurrency = useCallback((code: string): void => {
    setCurrencyCode(code);
    saveCurrency(code);
  }, []);
  const signOut = useCallback(() => void authProvider.signOut(), [authProvider]);

  // The auth gate comes before everything, and `loading` is a state of its own
  // rather than being folded into "signed out". Firebase restores a persisted
  // session asynchronously, so treating "not signed in yet" as "signed out"
  // would flash this screen at an already-signed-in reader on every load —
  // including offline, where the restore still succeeds.
  if (authState.status === 'loading') {
    return (
      <ScreenFrame>
        <p className="empty">Checking your account…</p>
      </ScreenFrame>
    );
  }

  if (authState.status === 'signedOut') {
    return (
      <SignInScreen
        auth={authProvider}
        error={authState.error}
        configured={configured}
        notice={
          idleSignOut
            ? `For security, you were signed out after ${idleMinutes} minutes of inactivity. ` +
              'Your fuel log is still in this browser — signing in again picks up where you ' +
              'left off.'
            : null
        }
      />
    );
  }

  // The display style is outside the fuel log, so the sync's notes are written
  // in the reader's locale too (#94).
  return (
    <DisplayProvider style={style} setCurrency={changeCurrency}>
      <FuelLogProvider
        store={store}
        remote={remote}
        uid={authState.user.uid}
        sharing={sharing}
        {...(syncState === undefined ? {} : { syncState })}
        {...(syncTimers === undefined ? {} : { syncTimers })}
      >
        <UnitsProvider units={units} setUnits={changeUnits}>
          <SessionProvider
            account={authState.user}
            onSignOut={signOut}
            syncEnabled={remote !== null}
            idleMinutes={idleMinutes}
          >
            <AppShell account={authState.user} onSignOut={signOut} initialTab={initialTab} />
          </SessionProvider>
        </UnitsProvider>
      </FuelLogProvider>
    </DisplayProvider>
  );
}
