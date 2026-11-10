import { useEffect, useMemo, useState } from 'react';
import { useFuelLog } from './fuelLog';

/**
 * Who each uid is, on a car that is shared (#66) — `null` on a car that is
 * not, where "entered by you" on every row would only be noise. The owner's
 * name comes from the membership; everyone else's from the car's members.
 */
export function useEnteredByNames(vehicleId: string | null): ReadonlyMap<string, string> | null {
  const { sharing, me, fillUps } = useFuelLog();
  // Kept with the car they are for, so another car's names are never shown.
  const [names, setNames] = useState<{ readonly vehicleId: string; readonly names: ReadonlyMap<string, string> | null } | null>(null);
  const { enabled, namesFor } = sharing;
  // Who entered this car's fill-ups, as a stable key: the names are asked for
  // again only when somebody new appears (#89), not after every sync.
  const entered = useMemo(
    () => [...new Set(fillUps.map((row) => row.enteredBy ?? ''))].sort().join('\n'),
    [fillUps],
  );

  useEffect(() => {
    let cancelled = false;
    if (!enabled || vehicleId === null || me === null) return;
    void namesFor(vehicleId, entered.split('\n'))
      .then((found) => {
        if (!cancelled) setNames({ vehicleId, names: found });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [enabled, namesFor, vehicleId, me, entered]);

  return enabled && me !== null && names !== null && names.vehicleId === vehicleId ? names.names : null;
}
