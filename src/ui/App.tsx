import type { ReactElement } from 'react';
import { useEffect, useMemo, useState } from 'react';
import type { FuelTrackerStore } from '../data/store';
import type { UnitPreferences } from '../domain/units';
import { shouldOnboard } from '../domain/onboardingGate';
import { applyPalette, preferredColorScheme, watchColorScheme } from './theme';
import { loadHasOnboarded, loadUnitPreferences, saveHasOnboarded, saveUnitPreferences } from './unitSettings';
import { useAppData } from './useAppData';
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

export interface AppProps {
  readonly store: FuelTrackerStore;
  /** Test seam: pins the palette instead of reading the system preference. */
  readonly initialTab?: Tab;
}

export function App({ store, initialTab = 'dashboard' }: AppProps): ReactElement {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [units, setUnits] = useState<UnitPreferences>(() => loadUnitPreferences());
  const [hasOnboarded, setHasOnboarded] = useState<boolean>(() => loadHasOnboarded());
  const data = useAppData(store);

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
              Everything stays in this browser. No account, no server, nothing uploaded.
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
        {tab === 'settings' && <SettingsScreen units={units} onChange={changeUnits} />}
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
