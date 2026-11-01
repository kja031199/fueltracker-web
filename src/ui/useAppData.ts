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
  /**
   * Live fill-ups across **every** vehicle, not just the selected one.
   *
   * The backup reminder needs the whole log: someone with three cars and four
   * fill-ups each has twelve worth losing, and counting only the selected
   * vehicle would quietly keep them under the prompt threshold.
   */
  readonly fillUpCount: number;
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
  const [fillUpCount, setFillUpCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const loaded = await store.vehicles();
      setVehicles(loaded);
      setFillUpCount(await store.fillUpCount());
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

  // Tombstones written by older builds still carry the receipt photograph,
  // notes and coordinates of fill-ups that were deleted (#25). Fixing the
  // writer does nothing for those, so the cleanup runs once per store: it is
  // idempotent, it only touches rows that are already deleted, and bumping
  // their `updatedAt` is what carries the erasure up to the account.
  useEffect(() => {
    void store.scrubTombstones().catch(() => {
      // Nothing a reader can act on, and `reload` already reports storage
      // being unavailable. Retried on the next load.
    });
  }, [store]);

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

  return { vehicles, fillUps, fillUpCount, loading, error, selectedVehicleId, selectVehicle, reload };
}
