/**
 * Loads everything the screens read, and exposes the actions that change it.
 *
 * Deliberately one hook rather than per-screen fetching. The data set is one
 * person's fuel log — a few hundred rows at most — so loading it once and
 * reloading after a write is simpler than caching, and it means a change made
 * on one screen is never stale on another.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FillUpSummary, PendingFillUpRecord, VehicleRecord } from '../data/records';
import type { FuelTrackerStore } from '../data/store';

export interface AppData {
  readonly vehicles: readonly VehicleRecord[];
  /**
   * The selected vehicle's fill-ups, **without photo bytes** (#53): held for
   * the whole session, and nothing here shows a photo. To edit one, load it
   * whole with `store.fillUp(id)`.
   */
  readonly fillUps: readonly FillUpSummary[];
  /**
   * Live fill-ups across **every** vehicle, not just the selected one.
   *
   * The backup reminder needs the whole log: someone with three cars and four
   * fill-ups each has twelve worth losing, and counting only the selected
   * vehicle would quietly keep them under the prompt threshold.
   */
  readonly fillUpCount: number;
  /**
   * Fill-ups sent by link and waiting for review (#3), newest first, across
   * every car.
   */
  readonly pending: readonly PendingFillUpRecord[];
  readonly loading: boolean;
  /** Set when loading failed — storage can be unavailable, not just empty. */
  readonly error: string | null;
  readonly selectedVehicleId: string | null;
  selectVehicle(id: string): void;
  reload(): Promise<void>;
}

/** Everything a load reads, applied to the screens as **one** update (#88). */
type Shown = Omit<AppData, 'selectVehicle' | 'reload'>;

const NOTHING_YET: Shown = {
  vehicles: [],
  fillUps: [],
  fillUpCount: 0,
  pending: [],
  loading: true,
  error: null,
  selectedVehicleId: null,
};

export function useAppData(store: FuelTrackerStore): AppData {
  const [shown, setShown] = useState<Shown>(NOTHING_YET);
  // The car somebody chose, which a load shows if it still exists. A ref, so
  // a load reads the latest choice without the choice re-creating `reload`.
  const wanted = useRef<string | null>(null);
  // Loads overlap — a save's reload and a sync's — and finish in any order. A
  // load that finishes after a later one has been shown would put older rows
  // back on screen, so it is dropped.
  const issued = useRef(0);
  const applied = useRef(0);

  /**
   * Reads everything a screen shows **at once and applies it in one update**
   * (#88). It used to set each part as it arrived — the cars, then the count,
   * then the queue, and the selected car's fill-ups one effect later — so each
   * save re-rendered every screen several times, and for a moment the
   * selection had moved to one car while the fill-ups shown were another's.
   */
  const load = useCallback(
    async (choice: string | null): Promise<void> => {
      const ticket = (issued.current += 1);
      try {
        const [vehicles, fillUpCount, pending] = await Promise.all([
          store.vehicles(),
          store.fillUpCount(),
          store.pendingFillUps(),
        ]);
        // Keep the chosen car if it still exists; otherwise fall back to the
        // first, so deleting the selected one cannot strand the screens
        // pointing at a row that is gone.
        const selectedVehicleId =
          choice !== null && vehicles.some((vehicle) => vehicle.id === choice) ? choice : (vehicles[0]?.id ?? null);
        // Fill-ups follow the selected car rather than being loaded wholesale,
        // since every statistic is computed per car (#53).
        const fillUps =
          selectedVehicleId === null ? [] : await store.fillUps(selectedVehicleId).catch(() => []);
        if (ticket < applied.current) return;
        applied.current = ticket;
        if (wanted.current === choice) wanted.current = selectedVehicleId;
        setShown({ vehicles, fillUps, fillUpCount, pending, selectedVehicleId, loading: false, error: null });
      } catch (cause) {
        if (ticket < applied.current) return;
        applied.current = ticket;
        const error = cause instanceof Error ? cause.message : 'Could not open local storage.';
        setShown((current) => ({ ...current, loading: false, error }));
      }
    },
    [store],
  );

  const reload = useCallback(() => load(wanted.current), [load]);

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

  /**
   * Shown once that car's fill-ups have been read, together with them — never
   * the new car with the old car's fill-ups (#88).
   */
  const selectVehicle = useCallback(
    (id: string) => {
      wanted.current = id;
      void load(id);
    },
    [load],
  );

  // One object per change, not per render (#88): the fuel log's context is
  // built from it, and a fresh one each render re-rendered every screen.
  return useMemo(() => ({ ...shown, selectVehicle, reload }), [shown, selectVehicle, reload]);
}
