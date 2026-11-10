import type { ReactElement } from 'react';
import { useId } from 'react';

/** Settings → Where your data lives: the honest note about copies. */
export function StorageSection(): ReactElement {
  // One base per rendering, so a component shown twice never repeats an id (#95).
  const idBase = useId();
  return (
    <section className="card" aria-labelledby={`${idBase}-storage-heading`}>
      <h2 className="card__title" id={`${idBase}-storage-heading`}>
        Where your data lives
      </h2>
      <p className="stack-sm">
        Your fuel log is stored in this browser and kept in your Google account. Nobody else can
        read it — not another signed-in person, and not anyone without your account — except a
        car you choose to share, which the people you share it with can see and log (Vehicles →
        Share).
      </p>
      <p className="stack-sm">
        Because there is a copy in your account, clearing your browser data no longer loses your
        history: signing in again pulls it back.
      </p>
      <p className="warning flush">
        Receipt photos are the exception. A large one stays on the device that took it rather than
        syncing, so it is the one thing a cleared browser can still lose. Exporting a backup is
        still worth doing — it is the only copy that does not depend on anyone else's service.
      </p>
    </section>
  );
}
