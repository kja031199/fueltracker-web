import type { ReactElement } from 'react';
import { useId } from 'react';
import type { AuthUser } from '../../data/auth';
import { describeSince } from '../../domain/format';
import { useSyncStatus } from '../fuelLog';
import { AccountId } from '../AccountId';
import { useDisplay } from '../session';

/** Settings → Account: who is signed in, their account id, sync, and signing out. */
export function AccountSection({
  account,
  onSignOut,
  syncEnabled,
}: {
  readonly account: AuthUser;
  readonly onSignOut?: (() => void) | undefined;
  /** False when this build has no backend configured, so nothing syncs. */
  readonly syncEnabled: boolean;
}): ReactElement {
  // One base per rendering, so a component shown twice never repeats an id (#95).
  const idBase = useId();
  const sync = useSyncStatus();
  const { locale } = useDisplay().style;
  return (
    <section className="card" aria-labelledby={`${idBase}-account-heading`}>
      <h2 className="card__title" id={`${idBase}-account-heading`}>
        Account
      </h2>
      <p className="stack-sm">
        Signed in as <strong>{account.email === '' ? account.displayName : account.email}</strong>.
      </p>

      <AccountId uid={account.uid}>
        Send this to whoever runs this copy of FuelTracker if they need to give your
        account access.
      </AccountId>

      {syncEnabled ? (
        <>
          <p className="stack-sm">
            Last synced {describeSince(sync.lastSyncedAt, Date.now(), locale)}.
          </p>
          <button
            className="button"
            type="button"
            onClick={() => void sync.syncNow()}
            disabled={sync.syncing}
          >
            {sync.syncing ? 'Syncing…' : 'Sync now'}
          </button>
          {sync.message !== null && (
            <p className="warning after-sm" role="status">
              {sync.message}
            </p>
          )}
        </>
      ) : (
        <p className="warning stack-sm">
          This build has no backend configured, so nothing is syncing — your fuel log is only on
          this device.
        </p>
      )}

      {onSignOut !== undefined && (
        <p className="after">
          <button className="button button--secondary" type="button" onClick={onSignOut}>
            Sign out
          </button>
        </p>
      )}
    </section>
  );
}
