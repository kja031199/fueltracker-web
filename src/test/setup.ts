/**
 * Loaded before every test file.
 *
 * `jest-dom` only registers matchers when a DOM is present, so importing it
 * unconditionally would throw in the node-environment suites. The guard keeps
 * one setup file working for both.
 */
import { afterEach } from 'vitest';

if (typeof document !== 'undefined') {
  await import('@testing-library/jest-dom/vitest');

  // The tab lives in the URL hash (#56), and jsdom keeps one URL for a whole
  // test file — so without this, a test that opened Settings would start the
  // next one on Settings too.
  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });
}
