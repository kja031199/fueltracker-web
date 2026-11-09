/**
 * The frame a fill-up link opens in (#3), and its way back to the app. Shared
 * by the request and the incoming-fill-up screens; it lived in
 * `SubmitScreen.tsx`, so one screen imported another's parts (#93).
 */

import type { ReactElement, ReactNode } from 'react';
import { ScreenFrame } from './ScreenFrame';

export function LinkScreen({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <ScreenFrame>
      <section className="card" aria-labelledby="link-screen-heading">
        <h2 className="card__title" id="link-screen-heading">
          {title}
        </h2>
        {children}
      </section>
    </ScreenFrame>
  );
}

export function DoneButton({ onDone, label = 'Go to FuelTracker' }: { readonly onDone: () => void; readonly label?: string }): ReactElement {
  return (
    <button className="button button--secondary" type="button" onClick={onDone}>
      {label}
    </button>
  );
}
