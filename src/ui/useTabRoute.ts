/**
 * Which tab is showing, kept in the URL hash (#56).
 *
 * It used to be React state, so a reload always landed on Dashboard, the
 * phone's Back button left the app instead of going back a tab, and nothing
 * could link to Settings. In the hash, all three work with no router and no
 * hosting rewrite: `#/settings` never reaches the server.
 *
 * - **Choosing a tab** sets `location.hash`, which adds a history entry — that
 *   is what makes Back step through tabs. Choosing the tab already shown adds
 *   nothing — assigning the same hash is not a navigation — so Back is never
 *   spent on a no-op.
 * - **The hash changing** for any other reason — Back, a typed address, a link
 *   — is followed through `hashchange`.
 * - **A hash that names no tab** (empty, mistyped, hostile) shows the default
 *   and is corrected with `replaceState`, which adds no entry: Back from the
 *   app should leave it, not land on the typo.
 */

import { useCallback, useEffect, useState } from 'react';

export const TABS = ['dashboard', 'fillups', 'vehicles', 'settings'] as const;
export type Tab = (typeof TABS)[number];

const PREFIX = '#/';

/**
 * The tab a hash names, or `null`. Exact match only: no case folding, no
 * trailing segments, no query — anything looser is a second spelling of a URL
 * that then has to be supported for ever.
 */
export function parseTab(hash: string): Tab | null {
  if (!hash.startsWith(PREFIX)) return null;
  const name = hash.slice(PREFIX.length);
  return (TABS as readonly string[]).includes(name) ? (name as Tab) : null;
}

export function hashFor(tab: Tab): string {
  return `${PREFIX}${tab}`;
}

/** The tab to show, and how to choose another. */
export function useTabRoute(fallback: Tab): readonly [Tab, (tab: Tab) => void] {
  const [tab, setTab] = useState<Tab>(() => parseTab(window.location.hash) ?? fallback);

  useEffect(() => {
    // Correct an address that names no tab, without spending a history entry.
    if (parseTab(window.location.hash) === null) {
      const { pathname, search } = window.location;
      window.history.replaceState(window.history.state, '', `${pathname}${search}${hashFor(fallback)}`);
    }
    function follow(): void {
      setTab(parseTab(window.location.hash) ?? fallback);
    }
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  }, [fallback]);

  const choose = useCallback((next: Tab) => {
    // Shown at once rather than on the `hashchange` that follows, which some
    // browsers deliver a task later.
    setTab(next);
    window.location.hash = hashFor(next);
  }, []);

  return [tab, choose] as const;
}
