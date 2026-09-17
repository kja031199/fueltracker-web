/**
 * Wires the accessible palette into the document.
 *
 * The colours are **not** written out as CSS by hand. They are read from
 * `accessiblePalette.ts` and set as custom properties at runtime, so the values
 * the browser paints are literally the ones the contrast tests measure. A
 * hand-copied hex in a stylesheet would be a second source of truth, and the
 * guarantee would quietly stop applying to what people actually see.
 */

import type { ColorScheme } from '../domain/accessiblePalette';
import { paletteCssVariables } from '../domain/accessiblePalette';

/** Sets the palette's custom properties on the document root. */
export function applyPalette(scheme: ColorScheme, root: HTMLElement): void {
  for (const [name, value] of Object.entries(paletteCssVariables(scheme))) {
    root.style.setProperty(name, value);
  }
  root.dataset['scheme'] = scheme;
}

/** The scheme the reader's system asks for. Defaults to light. */
export function preferredColorScheme(): ColorScheme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * Keeps the palette in step with the system setting.
 *
 * Returns an unsubscribe function. `addEventListener` on a media query list is
 * not available on every engine this might run on, so the older
 * `addListener` is used as a fallback rather than assuming.
 */
export function watchColorScheme(onChange: (scheme: ColorScheme) => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {};
  }
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = (event: MediaQueryListEvent): void => {
    onChange(event.matches ? 'dark' : 'light');
  };
  if (typeof query.addEventListener === 'function') {
    query.addEventListener('change', handler);
    return () => query.removeEventListener('change', handler);
  }
  query.addListener(handler);
  return () => query.removeListener(handler);
}
