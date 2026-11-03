import type { ReactElement } from 'react';

/**
 * Shown instead of the app when the browser will not open local storage —
 * private browsing, or a blocked-storage setting. Nothing could be saved, so
 * there is nothing else worth showing. Extracted from `App` (#56).
 */
export function StorageErrorScreen({ detail }: { readonly detail: string }): ReactElement {
  return (
    <div className="app">
      <main className="app__main">
        <h1 className="app__title">FuelTracker</h1>
        <p className="warning">
          Local storage is unavailable, so nothing can be saved or loaded. Private browsing or a
          blocked-storage setting is the usual cause. ({detail})
        </p>
      </main>
    </div>
  );
}
