/**
 * The frame a fill-up link opens in (#3), and its way back to the app. Shared
 * by the request and the incoming-fill-up screens; it lived in
 * `SubmitScreen.tsx`, so one screen imported another's parts (#93).
 */

import type { ReactElement, ReactNode } from 'react';
import { useId } from 'react';
import { ScreenFrame } from './ScreenFrame';

export function LinkScreen({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}): ReactElement {
  // One base per rendering, so a component shown twice never repeats an id (#95).
  const idBase = useId();
  return (
    <ScreenFrame section={title}>
      <section className="card" aria-labelledby={`${idBase}-link-screen-heading`}>
        <h2 className="card__title" id={`${idBase}-link-screen-heading`}>
          {title}
        </h2>
        {children}
      </section>
    </ScreenFrame>
  );
}

export function DoneButton({
  onDone,
  label = 'Go to FuelTracker',
}: {
  readonly onDone: () => void;
  readonly label?: string;
}): ReactElement {
  return (
    <button className="button button--secondary" type="button" onClick={onDone}>
      {label}
    </button>
  );
}
