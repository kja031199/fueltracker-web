/**
 * What a failed sync says, in words (#91).
 *
 * Sync reports what went wrong as a code (`SyncProblem`); the sentences are
 * here, with the rest of the app's wording, rather than in `data/sync.ts`.
 */

import type { SyncProblem } from '../data/sync';

/** Said when the device's list of shared cars cannot be read (#77): a pause, not a refusal. */
export const LEDGER_UNREADABLE =
  'Could not read which cars are shared with you on this device, so nothing was synced. It will be tried again.';

const TEXT: Record<SyncProblem, string> = {
  // The message a refused reader needs, which is not "check your connection":
  // the one actionable fact, the account id and who to send it to. It serves
  // the owner too — a rules deploy that refuses its own author reads as this
  // rather than as a network fault.
  refused:
    'This account does not have access to this FuelTracker, so nothing is syncing. ' +
    'Send your account id — Settings → Account — to whoever runs this copy.',
  // A refused upload from an account that is allowed (#50). Says nothing is
  // lost, because nothing is: every change is still in this browser.
  rejected:
    'Your account would not accept some changes, so they are saved on this device but not ' +
    'uploaded. Everything else keeps working; exporting a backup keeps a copy safe meanwhile.',
  'pull-failed': 'Could not reach your account.',
  'push-failed': 'Changes are saved here but not uploaded yet.',
  'ledger-unreadable': LEDGER_UNREADABLE,
};

/** The words for a failed sync, with the cause's own message where it helps. */
export function syncFailureMessage(failure: { readonly problem: SyncProblem; readonly detail?: string }): string {
  const text = TEXT[failure.problem];
  // Only for the network: a refusal's cause is the SDK's wording, and the
  // sentence above is the whole of what the reader can act on.
  const withDetail = failure.problem === 'pull-failed' || failure.problem === 'push-failed';
  return withDetail && failure.detail !== undefined ? `${text} (${failure.detail})` : text;
}
