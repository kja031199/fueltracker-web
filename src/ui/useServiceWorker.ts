/**
 * The service-worker registration and its update prompt.
 *
 * ## Why it asks instead of updating itself
 *
 * `vite-plugin-pwa` offers an automatic mode that activates a new worker and
 * reloads the page the moment one is available. For most sites that is right.
 * Here it would reload while someone is halfway through typing a fill-up and
 * discard it — and since this app holds the only copy of their data, losing
 * even one entry to a version bump is a bad trade for the convenience of not
 * clicking a button.
 *
 * So a new version waits, visibly, until the reader says go.
 */

import { useEffect, useState } from 'react';

export interface ServiceWorkerState {
  /** A new version is downloaded and waiting to take over. */
  readonly updateReady: boolean;
  /** The app has been cached and will now work without a network. */
  readonly offlineReady: boolean;
  /** Activates the waiting version and reloads. */
  update(): void;
  /** Dismisses the "ready to work offline" note. */
  dismissOfflineReady(): void;
}

export function useServiceWorker(): ServiceWorkerState {
  const [updateReady, setUpdateReady] = useState(false);
  const [offlineReady, setOfflineReady] = useState(false);
  const [apply, setApply] = useState<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Imported lazily so the virtual module never has to exist in a test or a
    // plain `vite dev` run, where no service worker is generated.
    void import('virtual:pwa-register')
      .then(({ registerSW }) => {
        if (cancelled) return;
        const updateSW = registerSW({
          onNeedRefresh: () => setUpdateReady(true),
          onOfflineReady: () => setOfflineReady(true),
        });
        setApply(() => () => void updateSW(true));
      })
      .catch(() => {
        // No service worker in this build. The app works exactly as before,
        // just without offline support, so there is nothing to report.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return {
    updateReady,
    offlineReady,
    update: () => apply?.(),
    dismissOfflineReady: () => setOfflineReady(false),
  };
}
