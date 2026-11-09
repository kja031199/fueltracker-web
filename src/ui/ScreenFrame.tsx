import type { ReactElement, ReactNode } from 'react';

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
  before,
  after,
  children,
}: {
  readonly title?: string;
  readonly before?: ReactNode;
  readonly after?: ReactNode;
  readonly children?: ReactNode;
}): ReactElement {
  return (
    <div className="app">
      {before}
      <main className="app__main">
        <h1 className="app__title">{title}</h1>
        {children}
      </main>
      {after}
    </div>
  );
}
