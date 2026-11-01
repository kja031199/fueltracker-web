import type { ReactElement } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FuelTrackerStore } from '../data/store';
import type { AuthProvider } from '../data/auth';
import { StubAuthProvider } from '../data/auth';
import type { RemoteStore } from '../data/remote';
import type { UnitPreferences } from '../domain/units';
import { shouldOnboard } from '../domain/onboardingGate';
import type { IdleTimeoutSetting } from '../domain/idleTimeout';
import { IDLE_TIMEOUT_OFF } from '../domain/idleTimeout';
import { clearActivity, loadIdleTimeoutSetting, saveIdleTimeoutSetting, useIdleTimeout } from './idleTimeout';
import { applyPalette, preferredColorScheme, watchColorScheme } from './theme';
import { loadHasOnboarded, loadUnitPreferences, saveHasOnboarded, saveUnitPreferences } from './unitSettings';
import { useAppData } from './useAppData';
import { useAuth } from './useAuth';
import { useSync } from './useSync';
import { useServiceWorker } from './useServiceWorker';
import { UpdateBanner } from './UpdateBanner';
import { BackupBanner } from './BackupBanner';
import { useBackupNudge } from './backupNudge';
import { saveJsonBackup } from './exportBackup';
import { SignInScreen } from './SignInScreen';
import { VehiclesScreen } from './VehiclesScreen';
import { SettingsScreen } from './SettingsScreen';
import { DashboardScreen } from './DashboardScreen';
import { FillUpsScreen } from './FillUpsScreen';

type Tab = 'dashboard' | 'fillups' | 'vehicles' | 'settings';

const TABS: readonly { readonly id: Tab; readonly label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'fillups', label: 'Fill-ups' },
  { id: 'vehicles', label: 'Vehicles' },
  { id: 'settings', label: 'Settings' },
];

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
  /** Test seam: pins the palette instead of reading the system preference. */
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
}

export function App({
  store,
  initialTab = 'dashboard',
  auth,
  remote = null,
  configured = true,
}: AppProps): ReactElement {
  // Memoised, or a new stub on every render would resubscribe forever.
  const authProvider = useMemo(() => auth ?? defaultAuth(), [auth]);
  const authState = useAuth(authProvider);
  const [tab, setTab] = useState<Tab>(initialTab);
  const [units, setUnits] = useState<UnitPreferences>(() => loadUnitPreferences());
  const [hasOnboarded, setHasOnboarded] = useState<boolean>(() => loadHasOnboarded());
  const [idleTimeout, setIdleTimeout] = useState<IdleTimeoutSetting>(() =>
    loadIdleTimeoutSetting(),
  );
  const [idleSignOut, setIdleSignOut] = useState(false);
  const data = useAppData(store);
  const sync = useSync(store, authState.status === 'signedIn' ? remote : null, data.reload);
  const backup = useBackupNudge(data.fillUpCount);
  const serviceWorker = useServiceWorker();

  const signedIn = authState.status === 'signedIn';
  const endIdleSession = useCallback(() => {
    // The marker is cleared so the next session starts its own clock rather
    // than inheriting an already-expired one and bouncing straight back out.
    clearActivity();
    setIdleSignOut(true);
    void authProvider.signOut();
  }, [authProvider]);
  // Armed only while signed in: there is nothing to end otherwise, and passing
  // the real setting on the sign-in screen would have it sign out the person
  // who is trying to sign in.
  useIdleTimeout(signedIn ? idleTimeout : IDLE_TIMEOUT_OFF, endIdleSession);

  // The palette is applied from the ported values rather than written as CSS,
  // so what the browser paints is what the contrast tests measure.
  useEffect(() => {
    const root = document.documentElement;
    applyPalette(preferredColorScheme(), root);
    return watchColorScheme((scheme) => applyPalette(scheme, root));
  }, []);

  function changeUnits(next: UnitPreferences): void {
    setUnits(next);
    saveUnitPreferences(next);
  }

  function changeIdleTimeout(next: IdleTimeoutSetting): void {
    setIdleTimeout(next);
    saveIdleTimeoutSetting(next);
  }

  function finishOnboarding(): void {
    saveHasOnboarded();
    setHasOnboarded(true);
  }

  const onboarding = useMemo(
    // Decided from loaded data, so a returning reader whose flag was cleared
    // (a new browser profile, an imported backup) is not marched through a
    // first-run flow over data they already have.
    () => !data.loading && shouldOnboard(hasOnboarded, data.vehicles.length),
    [data.loading, data.vehicles.length, hasOnboarded],
  );

  // The auth gate comes before everything, and `loading` is a state of its own
  // rather than being folded into "signed out". Firebase restores a persisted
  // session asynchronously, so treating "not signed in yet" as "signed out"
  // would flash this screen at an already-signed-in reader on every load —
  // including offline, where the restore still succeeds.
  if (authState.status === 'loading') {
    return (
      <div className="app">
        <p className="empty">Checking your account…</p>
      </div>
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
            ? `You were signed out after ${idleTimeout.minutes} minutes of inactivity, which is ` +
              'the setting you turned on. Your fuel log is still in this browser — signing in ' +
              'again picks up where you left off.'
            : null
        }
      />
    );
  }

  if (data.loading) {
    return (
      <div className="app">
        <p className="empty">Loading your fuel log…</p>
      </div>
    );
  }

  if (data.error !== null) {
    return (
      <div className="app">
        <main className="app__main">
          <h1 className="app__title">FuelTracker</h1>
          <p className="warning">
            Local storage is unavailable, so nothing can be saved or loaded. Private browsing or a
            blocked-storage setting is the usual cause. ({data.error})
          </p>
        </main>
      </div>
    );
  }

  if (onboarding) {
    return (
      <div className="app">
        <main className="app__main">
          <h1 className="app__title">Welcome to FuelTracker</h1>
          <section className="card">
            <p>
              Log every fill-up and this works out your real fuel economy, what you actually spend,
              and which day of the week you tend to catch the cheapest price.
            </p>
            <p>
              Your fuel log is saved on this device and kept in your Google account, so it survives
              clearing your browser data and follows you to your phone. Only you can read it.
            </p>
            <button className="button" type="button" onClick={finishOnboarding}>
              Get started
            </button>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className="app">
      <UpdateBanner state={serviceWorker} />
      <BackupBanner
        reason={backup.reason}
        onBackUp={() => {
          void saveJsonBackup(store).then((saved) => backup.recordBackup(saved.fillUps));
        }}
        onDismiss={backup.snooze}
      />
      <h1 className="app__title">FuelTracker</h1>
      <main className="app__main">
        {tab === 'vehicles' && (
          <VehiclesScreen
            store={store}
            vehicles={data.vehicles}
            selectedVehicleId={data.selectedVehicleId}
            onSelect={data.selectVehicle}
            onChanged={data.reload}
          />
        )}
        {tab === 'settings' && (
          <SettingsScreen
            units={units}
            onChange={changeUnits}
            store={store}
            onImported={data.reload}
            onBackedUp={backup.recordBackup}
            lastBackupAt={backup.state.lastExportAt}
            account={authState.user}
            onSignOut={() => void authProvider.signOut()}
            idleTimeout={idleTimeout}
            onIdleTimeoutChange={changeIdleTimeout}
            sync={sync}
            syncEnabled={remote !== null}
          />
        )}
        {tab === 'dashboard' && (
          <DashboardScreen
            vehicles={data.vehicles}
            selectedVehicleId={data.selectedVehicleId}
            onSelect={data.selectVehicle}
            fillUps={data.fillUps}
            units={units}
          />
        )}
        {tab === 'fillups' && (
          <FillUpsScreen
            store={store}
            vehicleId={data.selectedVehicleId}
            fillUps={data.fillUps}
            units={units}
            onChanged={data.reload}
          />
        )}
      </main>
      <nav className="tabs" aria-label="Sections">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            className="tabs__button"
            type="button"
            aria-current={tab === entry.id ? 'page' : undefined}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
