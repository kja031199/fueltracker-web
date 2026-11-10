import type { ReactElement } from 'react';
import { UnitsSection } from './settings/UnitsSection';
import { AccountSection } from './settings/AccountSection';
import { SecuritySection } from './settings/SecuritySection';
import { StorageSection } from './settings/StorageSection';
import { BackupSection } from './settings/BackupSection';
import { useSession } from './session';

/**
 * The account, units, and the honest note about where the data lives — one
 * component per section, in `ui/settings/` (#93). It takes no props: the
 * units and the session come from their contexts (`session.tsx`), where it
 * used to be handed eight.
 */
export function SettingsScreen(): ReactElement {
  const { account, onSignOut, syncEnabled, idleMinutes } = useSession();
  return (
    <div>
      <UnitsSection />
      {account !== undefined && <AccountSection account={account} onSignOut={onSignOut} syncEnabled={syncEnabled} />}
      <SecuritySection idleMinutes={idleMinutes} />
      <StorageSection />
      <BackupSection />
    </div>
  );
}
