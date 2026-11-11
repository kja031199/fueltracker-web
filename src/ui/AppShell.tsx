import type { ReactElement } from 'react';
import { Activity, useCallback, useEffect, useRef, useState } from 'react';
import type { AuthUser } from '../data/auth';
import { shouldOnboard } from '../domain/onboardingGate';
import { HAS_ONBOARDED } from './onboarding';
import { useAccountPreference } from './preferences';
import { useBackupStatus, useFuelLog, useSyncStatus } from './fuelLog';
import type { Tab } from './useTabRoute';
import { TAB_TABLE, TABS, useRoute } from './useTabRoute';
import { useServiceWorker } from './useServiceWorker';
import { UpdateBanner } from './UpdateBanner';
import { BackupBanner } from './BackupBanner';
import { ScreenFrame } from './ScreenFrame';
import { InvitationsBanner } from './InvitationsBanner';
import { NoAccessScreen } from './NoAccessScreen';
import { WelcomeScreen } from './WelcomeScreen';
import { StorageErrorScreen } from './StorageErrorScreen';
import { VehiclesScreen } from './VehiclesScreen';
import { SettingsScreen } from './SettingsScreen';
import { DashboardScreen } from './DashboardScreen';
import { FillUpsScreen } from './FillUpsScreen';
import { SubmitScreen } from './SubmitScreen';
import { IncomingScreen } from './IncomingScreen';

interface AppShellProps {
  readonly account: AuthUser;
  readonly onSignOut: () => void;
  readonly initialTab: Tab;
}

/**
 * Each tab's screen. A `Record` over `Tab`, so a tab added to `TAB_TABLE`
 * without a screen here — or a screen for a tab that is not there — does not
 * compile (#93).
 */
const SCREENS: Record<Tab, () => ReactElement> = {
  dashboard: () => <DashboardScreen />,
  fillups: () => <FillUpsScreen />,
  vehicles: () => <VehiclesScreen />,
  settings: () => <SettingsScreen />,
};

/**
 * The signed-in app, inside the fuel log.
 *
 * ## A tab keeps its state while another is shown (#93)
 *
 * Every tab used to be unmounted when another was chosen, so a half-typed
 * fill-up, the fill-ups filter and the dashboard's range were gone on the way
 * back — the very thing the PWA refuses to auto-update for. A tab is now
 * mounted the first time it is shown and then kept inside React's
 * `<Activity>`: hidden, it keeps its state, its effects are cleaned up until
 * it shows again, and it is `display: none`, so out of reach of the
 * keyboard and screen readers. The cost, accepted: a hidden tab still
 * re-renders, at low priority, when the fuel log changes.
 */
export function AppShell({ account, onSignOut, initialTab }: AppShellProps): ReactElement {
  const log = useFuelLog();
  const [route, setTab] = useRoute(initialTab);
  // The tabs shown so far, in the order they were first shown. Grown during
  // render rather than in an effect, so a newly chosen tab mounts in the
  // same render that shows it.
  const [visited, setVisited] = useState<readonly Tab[]>(() => (route.kind === 'tab' ? [route.tab] : []));
  if (route.kind === 'tab' && !visited.includes(route.tab)) setVisited([...visited, route.tab]);
  // After a change of route — a tab chosen, a link left — focus goes to the
  // page's title, which names where it landed (#95). Not on arrival: a page
  // that has just loaded leaves focus where the browser puts it. Compared
  // with the last route shown, not counted, so StrictMode's second effect
  // run in development is not mistaken for a change.
  const routeKey = route.kind === 'tab' ? `tab:${route.tab}` : route.kind;
  const shownRoute = useRef(routeKey);
  useEffect(() => {
    if (shownRoute.current === routeKey) return;
    shownRoute.current = routeKey;
    document.querySelector<HTMLElement>('main h1')?.focus();
  }, [routeKey]);
  const leaveLink = useCallback(() => setTab('dashboard', { replace: true }), [setTab]);
  const showReceived = useCallback(() => setTab('fillups', { replace: true }), [setTab]);
  // Account-scoped (#55): read for this uid, and re-read if it changes.
  const [hasOnboarded, setHasOnboarded] = useAccountPreference(HAS_ONBOARDED, account.uid, false);
  const backup = useBackupStatus();
  const serviceWorker = useServiceWorker();

  // Decided from loaded data, so a returning reader whose flag was cleared (a
  // new browser profile, an imported backup) is not marched through a
  // first-run flow over data they already have.
  const onboarding = !log.loading && shouldOnboard(hasOnboarded, log.vehicles.length);

  if (log.loading) {
    return (
      <ScreenFrame>
        <p className="empty">Loading your fuel log…</p>
      </ScreenFrame>
    );
  }

  if (log.error !== null) return <StorageErrorScreen detail={log.error} />;

  // Fill-up links (#3) come before the first-run screen: somebody asked to
  // log a fill-up may have no cars of their own, and would otherwise be walked
  // through setting up a log they do not want before seeing what they came for.
  // Every screen goes through the refusal gate, which is the only part of the
  // shell that reads sync status (#88): a sync re-renders the gate, and the
  // screens it is handed come through unchanged.
  const gated = (screen: ReactElement): ReactElement => (
    <RefusalGate account={account} onSignOut={onSignOut}>
      {screen}
    </RefusalGate>
  );

  if (route.kind === 'submit') {
    return gated(<SubmitScreen payload={route.payload} accountName={account.displayName} onDone={leaveLink} />);
  }
  if (route.kind === 'incoming') {
    return gated(<IncomingScreen payload={route.payload} onReceived={showReceived} onDone={leaveLink} />);
  }
  const { tab } = route;

  if (onboarding) return gated(<WelcomeScreen onStart={() => setHasOnboarded(true)} />);

  return gated(
    <ScreenFrame
      section={TAB_TABLE.find((entry) => entry.id === tab)?.label}
      before={
        <>
          <UpdateBanner state={serviceWorker} />
          <BackupBanner reason={backup.reason} onBackUp={() => void log.saveBackup()} onDismiss={backup.snooze} />
          <InvitationsBanner />
        </>
      }
      after={
        <nav className="tabs" aria-label="Sections">
          {TAB_TABLE.map((entry) => (
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
      }
    >
      {TABS.filter((id) => visited.includes(id) || id === tab).map((id) => (
        <Activity key={id} mode={id === tab ? 'visible' : 'hidden'}>
          {SCREENS[id]()}
        </Activity>
      ))}
    </ScreenFrame>,
  );
}

/**
 * The app, or — signed in, and the account said no (#41) — the no-access
 * screen instead. Shown instead of the app rather than beside it: the
 * first-run flow promises that a fuel log is kept in the reader's Google
 * account, and for this reader that is false — they would be logging
 * fill-ups that can never leave the device. A refusal does not clear on its
 * own, so this is not a flash during a slow network; `refused` is only set
 * for `permission-denied` and a successful sync clears it.
 *
 * Its own component (#88) so that sync status, which changes several times
 * per sync, re-renders only this: `children` are the same elements each time.
 */
function RefusalGate({
  account,
  onSignOut,
  children,
}: {
  readonly account: AppShellProps['account'];
  readonly onSignOut: AppShellProps['onSignOut'];
  readonly children: ReactElement;
}): ReactElement {
  const sync = useSyncStatus();
  const log = useFuelLog();
  if (!sync.refused) return children;
  const hasLocalData = log.vehicles.length > 0 || log.fillUpCount > 0;
  return (
    <NoAccessScreen
      account={account}
      onRetry={() => void sync.syncNow()}
      retrying={sync.syncing}
      onSignOut={onSignOut}
      // Offered only when there is something to lose. Somebody who had
      // access, logged fill-ups and then lost it would otherwise have their
      // own data stranded behind a Settings screen they cannot reach.
      onExport={hasLocalData ? () => void log.saveBackup() : undefined}
    />
  );
}
