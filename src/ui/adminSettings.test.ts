import { afterEach, describe, expect, test, vi } from 'vitest';

/**
 * The administrator's settings come from the build environment (#70).
 *
 * Each case sets the variable and imports the module afresh, the way a build
 * with that Variable would see it. Without this, a module that ignored the
 * environment and hard-coded 30 would pass every other test, because the
 * Variable is unset in tests and 30 is also the default.
 */

async function adminMinutes(raw: string | undefined): Promise<number> {
  vi.resetModules();
  if (raw === undefined) vi.stubEnv('VITE_IDLE_TIMEOUT_MINUTES', undefined as unknown as string);
  else vi.stubEnv('VITE_IDLE_TIMEOUT_MINUTES', raw);
  const { ADMIN_IDLE_MINUTES } = await import('./adminSettings');
  return ADMIN_IDLE_MINUTES;
}

// The env stubs are put back by the config (`unstubEnvs`); the module cache
// is not, and the next case must import the module afresh.
afterEach(() => {
  vi.resetModules();
});

describe('VITE_IDLE_TIMEOUT_MINUTES', () => {
  test('sets the period for everyone', async () => {
    expect(await adminMinutes('45')).toBe(45);
    expect(await adminMinutes('5')).toBe(5);
  });

  test('unset or empty — a repository Variable nobody created — means 30', async () => {
    expect(await adminMinutes(undefined)).toBe(30);
    expect(await adminMinutes('')).toBe(30);
  });

  test('cannot switch the protection off', async () => {
    for (const raw of ['off', '0', 'never', 'false', '-1']) {
      expect(await adminMinutes(raw), raw).toBe(30);
    }
  });
});
