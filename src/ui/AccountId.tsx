/**
 * The signed-in account's id, with a button to copy it.
 *
 * Shared by two screens that need it for the same reason. It is the identifier
 * the sign-in allowlist in `firestore.rules` matches on, and before #34 the
 * only way to read one was the Firebase console — which the person who needs
 * it usually cannot open, and which the owner therefore had to go digging
 * through on their behalf.
 *
 * It keeps working in exactly the case it is needed: the uid comes from Auth
 * rather than Firestore, so it still renders for somebody who is signed in but
 * refused, while every data read they attempt is being denied. That is why the
 * no-access screen (#41) can show it at all.
 *
 * Extracted rather than written twice: the clipboard handling has three
 * outcomes and a quiet failure mode, and two copies of it would drift.
 */

import type { ReactElement } from 'react';
import { useState } from 'react';

interface Props {
  readonly uid: string;
  /** Shown under the id. Each screen has its own reason for showing it. */
  readonly children?: React.ReactNode;
}

export function AccountId({ uid, children }: Props): ReactElement {
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null);

  /**
   * Puts the id on the clipboard, and says so either way.
   *
   * The id is on screen regardless, so the button is a convenience and its
   * failure is not important — but a dead button that silently does nothing is
   * worse than one that admits it. No clipboard at all is the ordinary case on
   * plain http or with the permission blocked.
   */
  async function copy(): Promise<void> {
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

  return (
    <>
      <p style={{ margin: '0 0 4px' }}>
        Your account id: <code>{uid}</code>
      </p>
      {children !== undefined && (
        <p style={{ margin: '0 0 8px', opacity: 0.8 }}>{children}</p>
      )}
      <p style={{ margin: '0 0 8px' }}>
        <button className="button button--secondary" type="button" onClick={() => void copy()}>
          Copy account id
        </button>
        {copied !== null && (
          // Deliberately not role="status": the settings screen already has
          // two, and a third would make `getByRole('status')` ambiguous for
          // every test that reads the sync or import message. `aria-live`
          // announces it without claiming the role.
          <span aria-live="polite" style={{ marginLeft: 8, opacity: 0.8 }}>
            {copied === 'yes'
              ? 'Copied.'
              : 'Your browser would not let the app use the clipboard — copy it by hand.'}
          </span>
        )}
      </p>
    </>
  );
}
