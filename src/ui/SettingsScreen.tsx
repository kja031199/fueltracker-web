import type { ReactElement } from 'react';
import { useRef, useState } from 'react';
import type { UnitPreferences } from '../domain/units';
import type { FuelTrackerStore } from '../data/store';
import type { AuthUser } from '../data/auth';
import type { SyncStatus } from './useSync';
import { backupFilename } from '../data/backup';
import { parseCsv, parseJsonBackup, toCsv } from '../domain/backupFormat';
import { downloadText } from './download';
import { saveJsonBackup } from './exportBackup';
import type { IdleTimeoutSetting } from '../domain/idleTimeout';
import { IDLE_MINUTE_CHOICES, IDLE_TIMEOUT_OFF } from '../domain/idleTimeout';
import {
  DISTANCE_UNITS,
  ECONOMY_UNITS,
  VOLUME_UNITS,
  distance,
  economy,
  volume,
} from '../domain/units';

interface Props {
  readonly units: UnitPreferences;
  readonly onChange: (units: UnitPreferences) => void;
  readonly store: FuelTrackerStore;
  readonly onImported: () => Promise<void>;
  /** Omitted by tests that are not about the account. */
  readonly account?: AuthUser;
  readonly onSignOut?: () => void;
  readonly sync?: SyncStatus;
  /** False when this build has no backend configured, so nothing syncs. */
  readonly syncEnabled?: boolean;
  /** Records that a JSON backup was taken, for the reminder. */
  readonly onBackedUp?: (fillUpCount: number) => void;
  /** Epoch ms of the last JSON backup, or null if there has never been one. */
  readonly lastBackupAt?: number | null;
  /** The idle-timeout setting for this browser. Off unless somebody asked. */
  readonly idleTimeout?: IdleTimeoutSetting;
  /** Omitted by tests that are not about the session timeout. */
  readonly onIdleTimeoutChange?: (setting: IdleTimeoutSetting) => void;
}

/** "3 minutes ago", falling back to a date once it stops being recent. */
export function describeSyncTime(at: number | null, now: number = Date.now()): string {
  if (at === null) return 'not yet';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return new Date(at).toLocaleDateString();
}

/**
 * The account, units, and the honest note about where the data lives.
 *
 * Changing a unit changes only what is shown and what typed numbers are read
 * as; every stored value stays canonical, so nothing is rewritten and nothing
 * can be lost in a conversion.
 */
export function SettingsScreen({
  units,
  onChange,
  store,
  onImported,
  account,
  onSignOut,
  sync,
  syncEnabled = false,
  onBackedUp,
  lastBackupAt = null,
  idleTimeout = IDLE_TIMEOUT_OFF,
  onIdleTimeoutChange,
}: Props): ReactElement {
  const fileInput = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [problems, setProblems] = useState<readonly string[]>([]);
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null);

  /**
   * Puts the account id on the clipboard, and says so either way.
   *
   * The id is on screen regardless, so the button is a convenience and its
   * failure is not important — but a dead button that silently does nothing is
   * worse than one that admits it. No clipboard at all is the ordinary case on
   * plain http or with the permission blocked.
   */
  async function copyAccountId(uid: string): Promise<void> {
    try {
      const clipboard: Clipboard | undefined = navigator.clipboard;
      if (clipboard === undefined) {
        setCopied('failed');
        return;
      }
      await clipboard.writeText(uid);
      setCopied('yes');
    } catch {
      setCopied('failed');
    }
  }

  async function exportJson(): Promise<void> {
    const saved = await saveJsonBackup(store);
    // Recorded so the reminder knows this happened. Only a JSON export counts
    // — see the CSV handler below.
    onBackedUp?.(saved.fillUps);
    setProblems([]);
    setStatus(
      `Saved a backup of ${saved.vehicles} vehicle(s) and ${saved.fillUps} fill-up(s).`,
    );
  }

  async function exportCsv(): Promise<void> {
    const snapshot = await store.exportSnapshot();
    // Tombstones are a backup concern, not a spreadsheet one — a deleted
    // fill-up is not a row anybody wants in their expenses.
    const live = snapshot.fillUps.filter((record) => record.deletedAt === null);
    downloadText(toCsv(live), backupFilename(new Date(), 'csv'), 'text/csv');
    setProblems([]);
    // Deliberately does NOT count as a backup. CSV is fill-ups only — no
    // vehicles, no tombstones, no receipt bytes — so marking someone protected
    // by it would be telling them a restore will return something it will not.
    setStatus(`Saved ${live.length} fill-up(s) as CSV.`);
  }

  async function importFile(file: File): Promise<void> {
    const text = await file.text();
    const isCsv = file.name.toLowerCase().endsWith('.csv');
    const parsed = isCsv ? parseCsv(text) : parseJsonBackup(text);

    if (parsed.value === null) {
      setStatus(null);
      setProblems([parsed.error ?? 'That file could not be read.']);
      return;
    }

    const snapshot = isCsv
      ? { vehicles: [], fillUps: parsed.value as never[], pendingFillUps: [] }
      : (parsed.value as Awaited<ReturnType<FuelTrackerStore['exportSnapshot']>>);
    const summary = await store.importBackup(snapshot);
    await onImported();

    setStatus(
      `Imported ${summary.fillUpsWritten} fill-up(s) and ${summary.vehiclesWritten} vehicle(s). ` +
        `${summary.skippedOlder} row(s) were already up to date.`,
    );
    setProblems([...parsed.skipped, ...summary.rejected]);
  }

  return (
    <div>
      <section className="card" aria-labelledby="units-heading">
        <h2 className="card__title" id="units-heading">
          Units
        </h2>

        <div className="field">
          <label className="field__label" htmlFor="unit-volume">
            Volume
          </label>
          <select
            id="unit-volume"
            value={units.volume}
            onChange={(e) =>
              onChange({ ...units, volume: e.target.value as UnitPreferences['volume'] })
            }
          >
            {VOLUME_UNITS.map((unit) => (
              <option key={unit} value={unit}>
                {volume[unit].name}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="unit-distance">
            Distance
          </label>
          <select
            id="unit-distance"
            value={units.distance}
            onChange={(e) =>
              onChange({ ...units, distance: e.target.value as UnitPreferences['distance'] })
            }
          >
            {DISTANCE_UNITS.map((unit) => (
              <option key={unit} value={unit}>
                {distance[unit].name}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="unit-economy">
            Fuel economy
          </label>
          <select
            id="unit-economy"
            value={units.economy}
            onChange={(e) =>
              onChange({ ...units, economy: e.target.value as UnitPreferences['economy'] })
            }
          >
            {ECONOMY_UNITS.map((unit) => (
              <option key={unit} value={unit}>
                {economy[unit].name}
              </option>
            ))}
          </select>
        </div>

        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', margin: 0 }}>
          Readings are stored in miles, US gallons and MPG whatever you pick here — changing a unit
          changes what you see and type, never what is saved.
        </p>
      </section>

      {account !== undefined && (
        <section className="card" aria-labelledby="account-heading">
          <h2 className="card__title" id="account-heading">
            Account
          </h2>
          <p style={{ margin: '0 0 8px' }}>
            Signed in as <strong>{account.email === '' ? account.displayName : account.email}</strong>.
          </p>

          {/* The identifier the sign-in allowlist in firestore.rules matches on.
              Shown here because it was otherwise only findable in the Firebase
              console, by the owner, after the person had already been refused —
              and because it comes from Auth rather than Firestore, so somebody
              who is signed in but not allowed through can still read their own
              id while every data read is being denied. */}
          <p style={{ margin: '0 0 4px' }}>
            Your account id: <code>{account.uid}</code>
          </p>
          <p style={{ margin: '0 0 8px', opacity: 0.8 }}>
            Send this to whoever runs this copy of FuelTracker if they need to give your
            account access.
          </p>
          <p style={{ margin: '0 0 8px' }}>
            <button
              className="button button--secondary"
              type="button"
              onClick={() => void copyAccountId(account.uid)}
            >
              Copy account id
            </button>
            {copied !== null && (
              // Deliberately not role="status": this screen already has two,
              // and a third would make `getByRole('status')` ambiguous for
              // every test that reads the sync or import message. aria-live
              // still announces it.
              <span aria-live="polite" style={{ marginLeft: 8, opacity: 0.8 }}>
                {copied === 'yes'
                  ? 'Copied.'
                  : 'Your browser would not let the app use the clipboard — copy it by hand.'}
              </span>
            )}
          </p>

          {syncEnabled && sync !== undefined ? (
            <>
              <p style={{ margin: '0 0 8px' }}>
                Last synced {describeSyncTime(sync.lastSyncedAt)}.
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
                <p className="warning" style={{ margin: '8px 0 0' }} role="status">
                  {sync.message}
                </p>
              )}
            </>
          ) : (
            <p className="warning" style={{ margin: '0 0 8px' }}>
              This build has no backend configured, so nothing is syncing — your fuel log is only on
              this device.
            </p>
          )}

          {onSignOut !== undefined && (
            <p style={{ margin: '12px 0 0' }}>
              <button className="button button--secondary" type="button" onClick={onSignOut}>
                Sign out
              </button>
            </p>
          )}
        </section>
      )}

      {onIdleTimeoutChange !== undefined && (
        <section className="card" aria-labelledby="security-heading">
          <h2 className="card__title" id="security-heading">
            Security
          </h2>
          <p style={{ margin: '0 0 8px' }}>
            <label>
              <input
                type="checkbox"
                checked={idleTimeout.enabled}
                onChange={(event) =>
                  onIdleTimeoutChange({ ...idleTimeout, enabled: event.target.checked })
                }
              />{' '}
              Sign out after a period of inactivity
            </label>
          </p>
          <p style={{ margin: '0 0 8px' }}>
            <label htmlFor="idle-minutes">Sign out when inactive for </label>
            <select
              id="idle-minutes"
              value={idleTimeout.minutes}
              disabled={!idleTimeout.enabled}
              onChange={(event) =>
                onIdleTimeoutChange({ ...idleTimeout, minutes: Number(event.target.value) })
              }
            >
              {IDLE_MINUTE_CHOICES.map((minutes) => (
                <option key={minutes} value={minutes}>
                  {minutes} minutes
                </option>
              ))}
            </select>
          </p>
          {/* The limits, next to the switch rather than in a help page. This
              protects less than its name suggests, and a lock that implies
              more safety than it delivers is worse than none. */}
          <p style={{ margin: '0 0 8px' }}>
            Your fuel log stays on this device either way. This ends the session; it does not hide
            your fill-ups from anyone who opens the browser&rsquo;s developer tools, and it is a
            small addition to locking the device itself.
          </p>
          <p className="warning" style={{ margin: 0 }}>
            Signing back in needs a connection, so a device that is offline cannot get back into the
            app until it reconnects. That is the trade for leaving this on.
          </p>
        </section>
      )}

      <section className="card" aria-labelledby="storage-heading">
        <h2 className="card__title" id="storage-heading">
          Where your data lives
        </h2>
        <p style={{ margin: '0 0 8px' }}>
          Your fuel log is stored in this browser and kept in your Google account. Nobody else can
          read it — not another signed-in person, and not anyone without your account.
        </p>
        <p style={{ margin: '0 0 8px' }}>
          Because there is a copy in your account, clearing your browser data no longer loses your
          history: signing in again pulls it back.
        </p>
        <p className="warning" style={{ margin: 0 }}>
          Receipt photos are the exception. A large one stays on the device that took it rather than
          syncing, so it is the one thing a cleared browser can still lose. Exporting a backup is
          still worth doing — it is the only copy that does not depend on anyone else's service.
        </p>
      </section>

      <section className="card" aria-labelledby="backup-heading">
        <h2 className="card__title" id="backup-heading">
          Backup and restore
        </h2>

        <p style={{ margin: '0 0 8px' }}>
          Last backup: <strong>{describeSyncTime(lastBackupAt)}</strong>.
        </p>
        <p style={{ margin: '0 0 12px', opacity: 0.8 }}>
          Only the JSON export counts as a backup. The CSV is fill-ups only — no vehicles, no
          deletions, no receipt photos — so it is for spreadsheets, not for restoring.
        </p>

        <div className="row-actions">
          <button className="button" type="button" onClick={() => void exportJson()}>
            Export backup (JSON)
          </button>
          <button className="button button--secondary" type="button" onClick={() => void exportCsv()}>
            Export spreadsheet (CSV)
          </button>
          <button
            className="button button--secondary"
            type="button"
            onClick={() => fileInput.current?.click()}
          >
            Import a file
          </button>
        </div>

        <input
          ref={fileInput}
          type="file"
          accept=".json,.csv,application/json,text/csv"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            // Reset first, so choosing the same file twice fires again.
            event.target.value = '';
            if (file !== undefined) void importFile(file);
          }}
        />

        {status !== null && (
          <p role="status" style={{ marginBottom: 0 }}>
            {status}
          </p>
        )}

        {problems.length > 0 && (
          <div className="warning" style={{ marginTop: 'var(--gap)' }}>
            <strong>{problems.length} row(s) could not be imported:</strong>
            <ul style={{ margin: '4px 0 0', paddingLeft: '1.2em' }}>
              {problems.slice(0, 10).map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
            {problems.length > 10 && <p style={{ margin: 0 }}>…and {problems.length - 10} more.</p>}
          </div>
        )}

        <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 0 }}>
          The JSON backup is the complete one — every vehicle, every fill-up, and the deletions
          too — and importing it merges rather than replaces, so restoring an old backup will not
          wipe out newer entries. The CSV is for spreadsheets: fill-ups only, in miles and US
          gallons whatever you have selected above, with the unit named in each column heading.
        </p>
      </section>
    </div>
  );
}
