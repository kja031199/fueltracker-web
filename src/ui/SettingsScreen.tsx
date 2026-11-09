import type { ReactElement } from 'react';
import type { UnitPreferences } from '../domain/units';
import type { AuthUser } from '../data/auth';
import { DEFAULT_IDLE_MINUTES } from '../domain/idleTimeout';
import { UnitsSection } from './settings/UnitsSection';
import { AccountSection } from './settings/AccountSection';
import { SecuritySection } from './settings/SecuritySection';
import { StorageSection } from './settings/StorageSection';
import { BackupSection } from './settings/BackupSection';

interface Props {
  readonly units: UnitPreferences;
  readonly onChange: (units: UnitPreferences) => void;
  /** Omitted by tests that are not about the account. */
  readonly account?: AuthUser;
  readonly onSignOut?: () => void;
  /** False when this build has no backend configured, so nothing syncs. */
  readonly syncEnabled?: boolean;
  /** The administrator's inactivity period (#70). Shown, never editable. */
  readonly idleMinutes?: number;
}

/**
 * The account, units, and the honest note about where the data lives — one
 * component per section, in \`ui/settings/\` (#93).
 */
export function SettingsScreen({
  units,
  onChange,
  account,
  onSignOut,
  syncEnabled = false,
  idleMinutes = DEFAULT_IDLE_MINUTES,
}: Props): ReactElement {
  return (
    <div>
      <UnitsSection units={units} onChange={onChange} />
      {account !== undefined && <AccountSection account={account} onSignOut={onSignOut} syncEnabled={syncEnabled} />}
      <SecuritySection idleMinutes={idleMinutes} />
      <StorageSection />
      <BackupSection />
    </div>
  );
}
