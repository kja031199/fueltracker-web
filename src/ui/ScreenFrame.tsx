import type { ReactElement, ReactNode } from 'react';
import { useEffect } from 'react';

/**
 * The page around every screen (#93): the app column, the title, the main
 * landmark.
 *
 * Nine screens wrote it out, and they had drifted: five put the title inside
 * `<main>` and two outside it, and the loading screens had none. The title is
 * always inside `<main>` now, so the page's heading is inside a landmark and a
 * skip to the main content lands on it. Banners go `before` it and the tab bar
 * `after`, both outside `<main>`.
 */
export function ScreenFrame({
  title = 'FuelTracker',
  section,
  before,
  after,
  children,
}: {
  readonly title?: string;
  /**
   * Which part of the app this is — "Vehicles", "Fill-up link" (#95). Heard
   * as part of the title, and the browser tab's title, so a screen reader
   * arriving here after a switch is told where it landed.
   */
  readonly section?: string | undefined;
  readonly before?: ReactNode;
  readonly after?: ReactNode;
  readonly children?: ReactNode;
}): ReactElement {
  useEffect(() => {
    document.title = section === undefined ? title : `${section} · ${title}`;
  }, [section, title]);

  return (
    <div className="app">
      {before}
      <main className="app__main">
        {/* Focusable from script, not by Tab (#95): after a route change,
            focus is moved here, so it is not left on <body> or on a button
            the change just removed. */}
        <h1 className="app__title" tabIndex={-1}>
          {title}
          {section !== undefined && (
            <>
              {' '}
              <span className="visually-hidden">— {section}</span>
            </>
          )}
        </h1>
        {children}
      </main>
      {after}
    </div>
  );
}
