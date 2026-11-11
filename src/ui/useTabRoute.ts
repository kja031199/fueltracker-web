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
 * - **A fill-up link** (#3) — `#/submit/<payload>` or `#/incoming/<payload>` —
 *   is a route of its own and is never "corrected": doing so would throw the
 *   link away before anything read it. Its payload is handed over as it
 *   stands; deciding whether it is any good is `data/fillUpLink.ts`'s job,
 *   so a damaged link is still shown — and named as damaged — rather than
 *   silently dropped on the dashboard. Leaving a link uses `replace`, so Back
 *   does not reopen it.
 */

import { useCallback, useEffect, useState } from 'react';

/**
 * Every tab, in the order the bar shows them, with its label — written once
 * (#93). The ids and the labels used to be two lists in two files, free to
 * drift apart. The screens are a `Record<Tab, …>` in `AppShell`, so a tab
 * without a screen is a type error too.
 */
export const TAB_TABLE = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'fillups', label: 'Fill-ups' },
  { id: 'vehicles', label: 'Vehicles' },
  { id: 'settings', label: 'Settings' },
] as const;

export type Tab = (typeof TAB_TABLE)[number]['id'];
export const TABS: readonly Tab[] = TAB_TABLE.map((entry) => entry.id);

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

export type Route =
  | { readonly kind: 'tab'; readonly tab: Tab }
  | { readonly kind: 'submit'; readonly payload: string }
  | { readonly kind: 'incoming'; readonly payload: string };

/** Exactly `#/submit/<one segment>` or `#/incoming/<one segment>`. */
const LINK_ROUTE = /^#\/(submit|incoming)\/([^/]+)$/;

/** The route a hash names, or `null`. As strict as `parseTab`. */
export function parseRoute(hash: string): Route | null {
  const tab = parseTab(hash);
  if (tab !== null) return { kind: 'tab', tab };
  const link = LINK_ROUTE.exec(hash);
  if (link === null) return null;
  const [, kind, payload = ''] = link;
  return kind === 'submit' ? { kind: 'submit', payload } : { kind: 'incoming', payload };
}

export interface ChooseOptions {
  /**
   * Replace the current history entry instead of adding one. For leaving a
   * fill-up link: Back should not land on it again.
   */
  readonly replace?: boolean;
}

/** The route to show, and how to choose a tab. */
export function useRoute(fallback: Tab): readonly [Route, (tab: Tab, options?: ChooseOptions) => void] {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash) ?? { kind: 'tab', tab: fallback });

  useEffect(() => {
    // Correct an address that names nothing, without spending a history entry.
    if (parseRoute(window.location.hash) === null) replaceHash(hashFor(fallback));
    function follow(): void {
      setRoute(parseRoute(window.location.hash) ?? { kind: 'tab', tab: fallback });
    }
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  }, [fallback]);

  const choose = useCallback((next: Tab, options: ChooseOptions = {}) => {
    // Shown at once rather than on the `hashchange` that follows, which some
    // browsers deliver a task later.
    setRoute({ kind: 'tab', tab: next });
    if (options.replace === true) replaceHash(hashFor(next));
    else window.location.hash = hashFor(next);
  }, []);

  return [route, choose] as const;
}

function replaceHash(hash: string): void {
  const { pathname, search } = window.location;
  window.history.replaceState(window.history.state, '', `${pathname}${search}${hash}`);
}
