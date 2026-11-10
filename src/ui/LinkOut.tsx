import type { ReactElement } from 'react';
import { useId } from 'react';
import { useCopyToClipboard } from './useCopyToClipboard';

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
  // One base per rendering, so a component shown twice never repeats an id (#95).
  const idBase = useId();
  const { state: copyState, copy } = useCopyToClipboard();
  const canShare = typeof navigator.share === 'function';

  async function share(): Promise<void> {
    try {
      await navigator.share({ title: label, url });
    } catch {
      // Cancelled, or refused: the link is still on screen to copy.
    }
  }

  return (
    <div className="field">
      <label className="field__label" htmlFor={`${idBase}-link-out`}>
        {label}
      </label>
      <textarea
        className="break-all"
        id={`${idBase}-link-out`}
        readOnly
        rows={3}
        value={url}
        onFocus={(event) => event.target.select()}
      />
      <div className="row-actions space-above-sm">
        <button className="button" type="button" onClick={() => void copy(url)}>
          Copy link
        </button>
        {canShare && (
          <button className="button button--secondary" type="button" onClick={() => void share()}>
            Share…
          </button>
        )}
      </div>
      {copyState !== 'idle' && (
        <p className="after-sm" role="status">
          {copyState === 'copied'
            ? 'Copied.'
            : 'This browser would not copy it. Select the link above and copy it yourself.'}
        </p>
      )}
    </div>
  );
}
