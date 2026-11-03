import type { ReactElement } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FuelTrackerStore } from '../data/store';
import type { AuthProvider, AuthUser } from '../data/auth';
import { StubAuthProvider } from '../data/auth';
import type { RemoteStore } from '../data/remote';
import type { SyncStateStore } from '../data/syncState';
import type { UnitPreferences } from '../domain/units';
import { shouldOnboard } from '../domain/onboardingGate';
import type { IdleTimeoutSetting } from '../domain/idleTimeout';
import { IDLE_TIMEOUT_OFF } from '../domain/idleTimeout';
import { clearActivity, loadIdleTimeoutSetting, saveIdleTimeoutSetting, useIdleTimeout } from './idleTimeout';
import { applyPalette, preferredColorScheme, watchColorScheme } from './theme';
import { loadUnitPreferences, saveUnitPreferences } from './unitSettings';
import { HAS_ONBOARDED } from './onboarding';
import { useAccountPreference } from './preferences';
import { useAuth } from './useAuth';
import { FuelLogProvider, useFuelLog } from './fuelLog';
import type { Tab } from './useTabRoute';
import { useTabRoute } from './useTabRoute';
import { useServiceWorker } from './useServiceWorker';
import { UpdateBanner } from './UpdateBanner';
import { BackupBanner } from './BackupBanner';
import { useBackupNudge } from './backupNudge';
import { SignInScreen } from './SignInScreen';
import { NoAccessScreen } from './NoAccessScreen';
import { WelcomeScreen } from './WelcomeScreen';
import { StorageErrorScreen } from './StorageErrorScreen';
import { VehiclesScreen } from './VehiclesScreen';
import { SettingsScreen } from './SettingsScreen';
import { DashboardScreen } from './DashboardScreen';
import { FillUpsScreen } from './FillUpsScreen';

/**
 * The composition root (#56): **auth → this browser's preferences → the fuel
 * log → the screens.**
 *
 * - `App` gates on auth and holds what belongs to the browser: units, the idle
 *   sign-out, the palette. It is one of two components allowed to name the
 *   store, and only hands it to the provider.
 * - `FuelLogProvider` owns the data, sync, and every write (`fuelLog.tsx`).
 * - `AppShell` is the signed-in app: account-scoped state (onboarding, the
 *   backup reminder), the tab in the URL hash (`useTabRoute`), and the screens.
 */

const TAB_LABELS: readonly { readonly id: Tab; readonly label: string }[] = [
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
}

export function App({
  store,
  initialTab = 'dashboard',
  auth,
  remote = null,
  configured = true,
  syncState,
}: AppProps): ReactElement {
  // Memoised, or a new stub on every render would resubscribe forever.
  const authProvider = useMemo(() => auth ?? defaultAuth(), [auth]);
  const authState = useAuth(authProvider);
  const [units, setUnits] = useState<UnitPreferences>(() => loadUnitPreferences());
  const [idleTimeout, setIdleTimeout] = useState<IdleTimeoutSetting>(() =>
    loadIdleTimeoutSetting(),
  );
  const [idleSignOut, setIdleSignOut] = useState(false);

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

  return (
    <FuelLogProvider
      store={store}
      remote={remote}
      uid={authState.user.uid}
      {...(syncState === undefined ? {} : { syncState })}
    >
      <AppShell
        account={authState.user}
        onSignOut={() => void authProvider.signOut()}
        initialTab={initialTab}
        units={units}
        onUnitsChange={changeUnits}
        idleTimeout={idleTimeout}
        onIdleTimeoutChange={changeIdleTimeout}
        syncEnabled={remote !== null}
      />
    </FuelLogProvider>
  );
}

interface AppShellProps {
  readonly account: AuthUser;
  readonly onSignOut: () => void;
  readonly initialTab: Tab;
  readonly units: UnitPreferences;
  readonly onUnitsChange: (units: UnitPreferences) => void;
  readonly idleTimeout: IdleTimeoutSetting;
  readonly onIdleTimeoutChange: (setting: IdleTimeoutSetting) => void;
  readonly syncEnabled: boolean;
}

/** The signed-in app, inside the fuel log. */
function AppShell({
  account,
  onSignOut,
  initialTab,
  units,
  onUnitsChange,
  idleTimeout,
  onIdleTimeoutChange,
  syncEnabled,
}: AppShellProps): ReactElement {
  const log = useFuelLog();
  const [tab, setTab] = useTabRoute(initialTab);
  // Account-scoped (#55): read for this uid, and re-read if it changes.
  const [hasOnboarded, setHasOnboarded] = useAccountPreference(HAS_ONBOARDED, account.uid, false);
  const backup = useBackupNudge(log.fillUpCount, account.uid);
  const serviceWorker = useServiceWorker();

  // Decided from loaded data, so a returning reader whose flag was cleared (a
  // new browser profile, an imported backup) is not marched through a
  // first-run flow over data they already have.
  const onboarding = !log.loading && shouldOnboard(hasOnboarded, log.vehicles.length);

  function backUp(): void {
    void log.saveBackup().then((saved) => backup.recordBackup(saved.fillUps));
  }

  if (log.loading) {
    return (
      <div className="app">
        <p className="empty">Loading your fuel log…</p>
      </div>
    );
  }

  if (log.error !== null) return <StorageErrorScreen detail={log.error} />;

  // Signed in, and the account said no (#41). Shown instead of the app rather
  // than beside it: the first-run flow promises that a fuel log is kept in the
  // reader's Google account, and for this reader that is false — they would be
  // logging fill-ups that can never leave the device. A refusal does not clear
  // on its own, so this is not a flash during a slow network; `refused` is only
  // set for `permission-denied` and a successful sync clears it.
  if (log.sync.refused) {
    const hasLocalData = log.vehicles.length > 0 || log.fillUpCount > 0;
    return (
      <NoAccessScreen
        account={account}
        onRetry={() => void log.sync.syncNow()}
        retrying={log.sync.syncing}
        onSignOut={onSignOut}
        // Offered only when there is something to lose. Somebody who had
        // access, logged fill-ups and then lost it would otherwise have their
        // own data stranded behind a Settings screen they cannot reach.
        onExport={hasLocalData ? () => void log.saveBackup() : undefined}
      />
    );
  }

  if (onboarding) return <WelcomeScreen onStart={() => setHasOnboarded(true)} />;

  return (
    <div className="app">
      <UpdateBanner state={serviceWorker} />
      <BackupBanner reason={backup.reason} onBackUp={backUp} onDismiss={backup.snooze} />
      <h1 className="app__title">FuelTracker</h1>
      <main className="app__main">
        {tab === 'vehicles' && <VehiclesScreen />}
        {tab === 'settings' && (
          <SettingsScreen
            units={units}
            onChange={onUnitsChange}
            onBackedUp={backup.recordBackup}
            lastBackupAt={backup.state.lastExportAt}
            account={account}
            onSignOut={onSignOut}
            idleTimeout={idleTimeout}
            onIdleTimeoutChange={onIdleTimeoutChange}
            syncEnabled={syncEnabled}
          />
        )}
        {tab === 'dashboard' && <DashboardScreen units={units} />}
        {tab === 'fillups' && <FillUpsScreen units={units} />}
      </main>
      <nav className="tabs" aria-label="Sections">
        {TAB_LABELS.map((entry) => (
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
