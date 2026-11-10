/**
 * What somebody sees when they are signed in but the account refused them.
 *
 * ## Why this replaces the app rather than sitting inside it
 *
 * Issue #41. Signing in succeeds for any Google account; being *allowed* is a
 * separate question that `firestore.rules` answers (#27). Before this, a
 * refused account got the ordinary app: no vehicles and no `hasOnboarded` flag
 * meant the first-run flow, which promises that a fuel log "is kept in your
 * Google account" and "survives clearing your browser data". For this reader
 * both sentences are false, and they could spend an evening logging fill-ups
 * that would never leave the device.
 *
 * So the app is replaced, not annotated. The alternative — a local-only mode —
 * would mean a second class of app state to explain, a backup reminder that has
 * to behave differently in it, and a reader quietly accumulating data in a
 * place the app has just finished telling them is not durable.
 *
 * ## But it is not a dead end
 *
 * Three things are reachable from here, because without them a block is just a
 * wall:
 *
 * - **The account id**, which is the one thing the owner needs in order to
 *   grant access. It comes from Auth rather than Firestore, so it is readable
 *   even while every data read is refused.
 * - **Try again**, because being added is a rules deploy that happens while the
 *   reader sits on this screen. Making them guess whether to reload is unkind.
 * - **An export**, when there is anything on the device. The case that makes a
 *   hard block unfair is somebody who *had* access, logged fill-ups and then
 *   lost it: blocking the app would otherwise strand their own data behind a
 *   Settings screen they can no longer reach.
 */

import type { ReactElement } from 'react';
import { useId } from 'react';
import type { AuthUser } from '../data/auth';
import { AccountId } from './AccountId';
import { ScreenFrame } from './ScreenFrame';

interface Props {
  readonly account: AuthUser;
  readonly onRetry: () => void;
  readonly retrying: boolean;
  readonly onSignOut: () => void;
  /**
   * Omitted when the device holds nothing worth exporting.
   *
   * Spelled with `| undefined` because `exactOptionalPropertyTypes` is on:
   * the caller decides per render, so it passes the prop either way.
   */
  readonly onExport?: (() => void) | undefined;
}

export function NoAccessScreen({
  account,
  onRetry,
  retrying,
  onSignOut,
  onExport,
}: Props): ReactElement {
  // One base per rendering, so a component shown twice never repeats an id (#95).
  const idBase = useId();
  const name = account.email === '' ? account.displayName : account.email;

  return (
    <ScreenFrame>
      <section className="card" aria-labelledby={`${idBase}-no-access-heading`}>
        <h2 className="card__title" id={`${idBase}-no-access-heading`}>
          This account does not have access
        </h2>
        <p className="stack-sm">
          You are signed in as <strong>{name}</strong>, but this copy of FuelTracker only
          syncs for accounts that have been added to it. Nothing you enter here would be
          saved to your account, so the app stays closed rather than pretending otherwise.
        </p>

        <AccountId uid={account.uid}>
          Send this to whoever runs this copy of FuelTracker and ask them to add it.
        </AccountId>

        <p className="stack-sm">
          Adding an account means deploying a change, so it is{' '}
          <strong>not immediate</strong> — expect a few minutes rather than seconds. When
          they tell you it is done, use <em>Try again</em>; there is no need to reload.
        </p>

        <p className="after row-wrap">
          <button className="button" type="button" onClick={onRetry} disabled={retrying}>
            {retrying ? 'Checking…' : 'Try again'}
          </button>
          <button className="button button--secondary" type="button" onClick={onSignOut}>
            Sign out
          </button>
          {onExport !== undefined && (
            <button className="button button--secondary" type="button" onClick={onExport}>
              Export what is on this device
            </button>
          )}
        </p>

        {onExport !== undefined && (
          <p className="warning after">
            There are fill-ups stored in this browser that have not reached any account.
            Export them before clearing your browser data or signing out on this device —
            that file is the only copy.
          </p>
        )}
      </section>
    </ScreenFrame>
  );
}
