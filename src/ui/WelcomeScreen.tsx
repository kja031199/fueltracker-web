import type { ReactElement } from 'react';

/**
 * The first-run screen. Shown once per account (#55), and only to an empty fuel
 * log — `shouldOnboard` in `domain/onboardingGate.ts` decides. Extracted from
 * `App` (#56), which had it inline beside eight other concerns.
 */
export function WelcomeScreen({ onStart }: { readonly onStart: () => void }): ReactElement {
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
            Your fuel log is saved on this device and kept in your Google account, so it survives
            clearing your browser data and follows you to your phone. Only you can read it.
          </p>
          <button className="button" type="button" onClick={onStart}>
            Get started
          </button>
        </section>
      </main>
    </div>
  );
}
