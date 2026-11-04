import type { ReactElement } from 'react';
import { useState } from 'react';

/**
 * The page a link opens on: this one, without its hash (#3).
 *
 * Read from `location` rather than `new URL`, and without the search string
 * too — the link is the payload, nothing else of this address belongs in it.
 */
export function appBase(): string {
  return `${window.location.origin}${window.location.pathname}`;
}

interface Props {
  readonly url: string;
  /** What the link is, for the field's label and the share sheet. */
  readonly label: string;
}

/**
 * A link to pass on: shown in full so it can always be copied by hand, with
 * **Copy** and — where the browser has a share sheet — **Share**.
 *
 * Neither is assumed to work. A clipboard can be refused (no permission, not a
 * secure context) and a share sheet cancelled; the link is on screen either
 * way, and a failed copy says so rather than claiming success.
 */
export function LinkOut({ url, label }: Props): ReactElement {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const canShare = typeof navigator.share === 'function';

  async function copy(): Promise<void> {
    try {
      if (navigator.clipboard === undefined) throw new Error('no clipboard');
      await navigator.clipboard.writeText(url);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  }

  async function share(): Promise<void> {
    try {
      await navigator.share({ title: label, url });
    } catch {
      // Cancelled, or refused: the link is still on screen to copy.
    }
  }

  return (
    <div className="field">
      <label className="field__label" htmlFor="link-out">
        {label}
      </label>
      <textarea
        id="link-out"
        readOnly
        rows={3}
        value={url}
        onFocus={(event) => event.target.select()}
        style={{ wordBreak: 'break-all' }}
      />
      <div className="row-actions" style={{ marginTop: 8 }}>
        <button className="button" type="button" onClick={() => void copy()}>
          Copy link
        </button>
        {canShare && (
          <button className="button button--secondary" type="button" onClick={() => void share()}>
            Share…
          </button>
        )}
      </div>
      {copyState !== 'idle' && (
        <p role="status" style={{ margin: '8px 0 0' }}>
          {copyState === 'copied'
            ? 'Copied.'
            : 'This browser would not copy it. Select the link above and copy it yourself.'}
        </p>
      )}
    </div>
  );
}
