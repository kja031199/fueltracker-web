import type { ReactElement } from 'react';
import { useId } from 'react';

/** Settings → Security: the administrator's inactivity sign-out (#70), and what it does not protect. */
export function SecuritySection({ idleMinutes }: { readonly idleMinutes: number }): ReactElement {
  // One base per rendering, so a component shown twice never repeats an id (#95).
  const idBase = useId();
  return (
    <section className="card" aria-labelledby={`${idBase}-security-heading`}>
      <h2 className="card__title" id={`${idBase}-security-heading`}>
        Security
      </h2>
      {/* Stated, not offered (#70): the period is set for everyone by the
          administrator, and there is nothing here to change or switch off. */}
      <p className="stack-sm">
        For security, you are signed out after {idleMinutes} minutes of inactivity. This applies to everyone using
        FuelTracker and cannot be changed here.
      </p>
      {/* The limits, next to the statement rather than in a help page. This
          protects less than its name suggests, and a lock that implies more
          safety than it delivers is worse than none. */}
      <p className="stack-sm">
        Your fuel log stays on this device either way. Signing out ends the session; it does not hide your fill-ups from
        anyone who opens the browser&rsquo;s developer tools, and it is a small addition to locking the device itself.
      </p>
      <p className="warning flush">
        Signing back in needs a connection, so a device that is offline cannot get back into the app until it
        reconnects.
      </p>
    </section>
  );
}
