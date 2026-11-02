/**
 * What a development build shows when it is configured for production (#45).
 *
 * `main.tsx` renders this *instead of* starting Firebase: no auth, no database,
 * no network. Its reader is the developer who just ran `npm run dev`, so it
 * says exactly what is wrong and where the fix is written down. It is
 * deliberately not the sign-in screen's "not configured" state — the build is
 * configured, just for the wrong project, and saying otherwise would send them
 * looking for a missing file.
 */

import type { ReactElement } from 'react';

interface Props {
  readonly projectId: string;
}

export function WrongProjectScreen({ projectId }: Props): ReactElement {
  return (
    <div className="app">
      <main className="app__main">
        <h1 className="app__title">FuelTracker</h1>
        <section className="card" aria-labelledby="wrong-project-heading">
          <h2 className="card__title" id="wrong-project-heading">
            This development build is pointed at the production project
          </h2>
          <p style={{ margin: '0 0 8px' }}>
            <code>.env.local</code> names <code>{projectId}</code>, which is where the live
            site keeps everyone&apos;s fuel logs. A build running on your own machine is not
            allowed to use it, so nothing has been started: no sign-in, no sync, no local
            database.
          </p>
          <p style={{ margin: 0 }}>
            Point <code>.env.local</code> at a development project instead. The steps are in{' '}
            <code>docs/deploying.md</code>, under &ldquo;Local development uses its own
            project&rdquo;.
          </p>
        </section>
      </main>
    </div>
  );
}
