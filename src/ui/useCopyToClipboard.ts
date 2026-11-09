import { useCallback, useState } from 'react';

/**
 * Copying text, and saying honestly whether it worked (#93).
 *
 * Shared by the link panel and the account id, which had a copy each — and
 * `AccountId` warned that two copies of this would drift. A clipboard can be
 * missing (plain http, an old browser) or refuse (a blocked permission); both
 * read as `failed`, never as `copied`, because a button that claims success
 * and did nothing is worse than one that admits it. The text is always on
 * screen to copy by hand.
 */
export type CopyState = 'idle' | 'copied' | 'failed';

export function useCopyToClipboard(): { readonly state: CopyState; readonly copy: (text: string) => Promise<void> } {
  const [state, setState] = useState<CopyState>('idle');
  const copy = useCallback(async (text: string): Promise<void> => {
    try {
      const clipboard: Clipboard | undefined = navigator.clipboard;
      if (clipboard === undefined) throw new Error('no clipboard');
      await clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('failed');
    }
  }, []);
  return { state, copy };
}
