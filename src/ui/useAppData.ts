/**
 * Loads everything the screens read, and exposes the actions that change it.
 *
 * Deliberately one hook rather than per-screen fetching. The data set is one
 * person's fuel log — a few hundred rows at most — so loading it once and
 * reloading after a write is simpler than caching, and it means a change made
 * on one screen is never stale on another.
 */

import { useCallback, useEffect, useState } from 'react';
import type { FillUpRecord, VehicleRecord } from '../data/records';
import type { FuelTrackerStore } from '../data/store';

export interface AppData {
  readonly vehicles: readonly VehicleRecord[];
  readonly fillUps: readonly FillUpRecord[];
  readonly loading: boolean;
  /** Set when loading failed — storage can be unavailable, not just empty. */
  readonly error: string | null;
  readonly selectedVehicleId: string | null;
  selectVehicle(id: string): void;
  reload(): Promise<void>;
}

export function useAppData(store: FuelTrackerStore): AppData {
  const [vehicles, setVehicles] = useState<readonly VehicleRecord[]>([]);
  const [fillUps, setFillUps] = useState<readonly FillUpRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const loaded = await store.vehicles();
      setVehicles(loaded);
      setSelectedVehicleId((current) => {
        // Keep the current selection if it still exists; otherwise fall back to
        // the first vehicle, so deleting the selected one cannot strand the UI
        // pointing at a row that is gone.
        if (current !== null && loaded.some((v) => v.id === current)) return current;
        return loaded[0]?.id ?? null;
      });
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not open local storage.');
    } finally {
      setLoading(false);
    }
  }, [store]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Fill-ups follow the selected vehicle rather than being loaded wholesale,
  // since every statistic is computed per vehicle.
  useEffect(() => {
    let cancelled = false;
    if (selectedVehicleId === null) {
      setFillUps([]);
      return () => {
        cancelled = true;
      };
    }
    void store
      .fillUps(selectedVehicleId)
      .then((rows) => {
        if (!cancelled) setFillUps(rows);
      })
      .catch(() => {
        if (!cancelled) setFillUps([]);
      });
    return () => {
      cancelled = true;
    };
  }, [store, selectedVehicleId, vehicles]);

  const selectVehicle = useCallback((id: string) => setSelectedVehicleId(id), []);

  return { vehicles, fillUps, loading, error, selectedVehicleId, selectVehicle, reload };
}
