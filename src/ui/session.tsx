/**
 * What the screens need to know about this browser and this session, without
 * it being handed down through every one of them (#93).
 *
 * `units` was a prop on six components and Settings took eight; the screens
 * between App and the one that used a value only passed it along. Two small
 * contexts instead: the reader's units, which they change in Settings, and the
 * session — who is signed in, how to sign out, whether anything syncs, and the
 * administrator's idle period.
 */

import type { ReactElement, ReactNode } from 'react';
import { createContext, useContext, useMemo } from 'react';
import type { UnitPreferences } from '../domain/units';
import { US } from '../domain/units';
import type { AuthUser } from '../data/auth';
import { DEFAULT_IDLE_MINUTES } from '../domain/idleTimeout';

export interface Units {
  readonly units: UnitPreferences;
  readonly setUnits: (units: UnitPreferences) => void;
}

/**
 * Without a provider — a screen rendered on its own in a test — the units are
 * US and changing them does nothing. Storage is canonical whatever the units
 * (miles, US gallons, MPG), so US reproduces what is stored exactly.
 */
const UNITS_DEFAULT: Units = { units: US, setUnits: () => {} };

const UnitsContext = createContext<Units>(UNITS_DEFAULT);

export function UnitsProvider({
  units,
  setUnits,
  children,
}: Units & { readonly children: ReactNode }): ReactElement {
  const value = useMemo(() => ({ units, setUnits }), [units, setUnits]);
  return <UnitsContext.Provider value={value}>{children}</UnitsContext.Provider>;
}

/** The reader's units, and the way to change them. */
export function useUnits(): Units {
  return useContext(UnitsContext);
}

export interface Session {
  /** Who is signed in. Absent outside a signed-in app, and in tests that are not about the account. */
  readonly account?: AuthUser | undefined;
  readonly onSignOut?: (() => void) | undefined;
  /** False when this build has no backend configured, so nothing syncs. */
  readonly syncEnabled: boolean;
  /** The administrator's inactivity period (#70). Shown, never editable. */
  readonly idleMinutes: number;
}

const SessionContext = createContext<Session>({ syncEnabled: false, idleMinutes: DEFAULT_IDLE_MINUTES });

export function SessionProvider({ children, ...session }: Session & { readonly children: ReactNode }): ReactElement {
  const { account, onSignOut, syncEnabled, idleMinutes } = session;
  const value = useMemo(
    () => ({ account, onSignOut, syncEnabled, idleMinutes }),
    [account, onSignOut, syncEnabled, idleMinutes],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/** The signed-in session, as Settings shows it. */
export function useSession(): Session {
  return useContext(SessionContext);
}
