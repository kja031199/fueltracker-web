import type { ReactElement } from 'react';
import type { ServiceWorkerState } from './useServiceWorker';

/**
 * The two things a service worker has to tell someone.
 *
 * Both are `role="status"` rather than `role="alert"`: neither interrupts what
 * the reader is doing, and an alert would seize a screen reader mid-sentence
 * to announce that a cache warmed up.
 */
export function UpdateBanner({ state }: { state: ServiceWorkerState }): ReactElement | null {
  if (state.updateReady) {
    return (
      <div className="banner" role="status">
        <span>A new version is ready.</span>
        <button className="button" type="button" onClick={state.update}>
          Reload
        </button>
      </div>
    );
  }

  if (state.offlineReady) {
    return (
      <div className="banner" role="status">
        <span>Ready to work offline.</span>
        <button className="button button--secondary" type="button" onClick={state.dismissOfflineReady}>
          Got it
        </button>
      </div>
    );
  }

  return null;
}
