/**
 * Loaded before every test file.
 *
 * `jest-dom` only registers matchers when a DOM is present, so importing it
 * unconditionally would throw in the node-environment suites. The guard keeps
 * one setup file working for both.
 */
export {};

if (typeof document !== 'undefined') {
  await import('@testing-library/jest-dom/vitest');
}
