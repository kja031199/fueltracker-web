import { describe, expect, test } from 'vitest';
import { shouldOnboard } from './onboardingGate';

describe('shouldOnboard', () => {
  test('is shown to a new user with no vehicles', () => {
    expect(shouldOnboard(false, 0)).toBe(true);
  });

  test('is not shown once completed or skipped', () => {
    expect(shouldOnboard(true, 0)).toBe(false);
  });

  test('is not shown when vehicles already exist', () => {
    // Upstream: a fresh install that synced vehicles from iCloud before the
    // completion flag was ever set on this device. Here: an imported backup, or
    // a second browser profile.
    expect(shouldOnboard(false, 2)).toBe(false);
  });

  test('is not shown when completed and vehicles exist', () => {
    expect(shouldOnboard(true, 3)).toBe(false);
  });

  test('treats a nonsense vehicle count as "has data"', () => {
    // The count arrives from a caller rather than being computed here, so a
    // negative or non-finite value is possible. Only an exact zero opens the
    // gate — anything else errs toward not interrupting an existing user.
    expect(shouldOnboard(false, -1)).toBe(false);
    expect(shouldOnboard(false, Number.NaN)).toBe(false);
  });
});
