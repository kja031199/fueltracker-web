// @vitest-environment jsdom
import { describe, expect, test, vi } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook } from '@testing-library/react';
import { METRIC, US } from '../domain/units';
import { DEFAULT_IDLE_MINUTES } from '../domain/idleTimeout';
import { SessionProvider, UnitsProvider, useSession, useUnits } from './session';

/** The reader's units and the session, as contexts rather than props (#93). */

describe('useUnits', () => {
  test('without a provider, US — which is exactly what is stored — and changing them does nothing', () => {
    const { result } = renderHook(() => useUnits());
    expect(result.current.units).toEqual(US);
    expect(() => result.current.setUnits(METRIC)).not.toThrow();
    expect(result.current.units).toEqual(US);
  });

  test('inside one, the provider’s units, and its setter', () => {
    const setUnits = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }): ReactNode => (
      <UnitsProvider units={METRIC} setUnits={setUnits}>
        {children}
      </UnitsProvider>
    );
    const { result } = renderHook(() => useUnits(), { wrapper });
    expect(result.current.units).toEqual(METRIC);
    result.current.setUnits(US);
    expect(setUnits).toHaveBeenCalledWith(US);
  });

  test('the same units give the same context value, so nothing re-renders for nothing', () => {
    const setUnits = vi.fn();
    let units = METRIC;
    const wrapper = ({ children }: { children: ReactNode }): ReactNode => (
      <UnitsProvider units={units} setUnits={setUnits}>
        {children}
      </UnitsProvider>
    );
    const { result, rerender } = renderHook(() => useUnits(), { wrapper });
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
    units = US;
    rerender();
    expect(result.current).not.toBe(first);
  });
});

describe('useSession', () => {
  test('without a provider: nobody signed in, nothing syncing, the default idle period', () => {
    const { result } = renderHook(() => useSession());
    expect(result.current).toEqual({ syncEnabled: false, idleMinutes: DEFAULT_IDLE_MINUTES });
  });

  test('inside one, what it was given', () => {
    const account = { uid: 'u', email: 'u@example.com', displayName: 'U' };
    const onSignOut = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }): ReactNode => (
      <SessionProvider account={account} onSignOut={onSignOut} syncEnabled idleMinutes={15}>
        {children}
      </SessionProvider>
    );
    const { result } = renderHook(() => useSession(), { wrapper });
    expect(result.current).toEqual({ account, onSignOut, syncEnabled: true, idleMinutes: 15 });
  });

  test('a changed value reaches the screens: every field is part of the value', () => {
    const account = { uid: 'u', email: 'u@example.com', displayName: 'U' };
    const onSignOut = vi.fn();
    let session = { syncEnabled: false, idleMinutes: 30 };
    const wrapper = ({ children }: { children: ReactNode }): ReactNode => (
      <SessionProvider account={account} onSignOut={onSignOut} {...session}>
        {children}
      </SessionProvider>
    );
    const { result, rerender } = renderHook(() => useSession(), { wrapper });
    session = { syncEnabled: false, idleMinutes: 5 };
    rerender();
    expect(result.current.idleMinutes).toBe(5);
    session = { syncEnabled: true, idleMinutes: 5 };
    rerender();
    expect(result.current.syncEnabled).toBe(true);
  });
});
