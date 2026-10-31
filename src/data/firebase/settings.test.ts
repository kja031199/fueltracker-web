import { describe, expect, it } from 'vitest';
import { readSettings } from './settings';

const COMPLETE = {
  VITE_FIREBASE_API_KEY: 'test-key',
  VITE_FIREBASE_AUTH_DOMAIN: 'example.firebaseapp.com',
  VITE_FIREBASE_PROJECT_ID: 'example',
  VITE_FIREBASE_APP_ID: '1:2:web:3',
};

describe('readSettings', () => {
  it('reads a complete config', () => {
    expect(readSettings(COMPLETE)).toEqual({
      apiKey: 'test-key',
      authDomain: 'example.firebaseapp.com',
      projectId: 'example',
      appId: '1:2:web:3',
    });
  });

  it('reports an empty environment as unconfigured', () => {
    // A checkout with no .env.local has to keep working, so this is a supported
    // state rather than a failure.
    expect(readSettings({})).toBeNull();
  });

  it.each(Object.keys(COMPLETE))('treats a missing %s as unconfigured', (missing) => {
    const partial = { ...COMPLETE } as Record<string, string | undefined>;
    delete partial[missing];
    // Three values out of four cannot sign anyone in. A half-configured build
    // that renders a live-looking button is worse than one that says what is
    // missing.
    expect(readSettings(partial)).toBeNull();
  });

  it('treats whitespace as unconfigured', () => {
    // `VITE_FIREBASE_APP_ID= ` in a .env file yields a single space, which is
    // not a configuration but would pass a bare emptiness test.
    expect(readSettings({ ...COMPLETE, VITE_FIREBASE_APP_ID: '   ' })).toBeNull();
  });

  it('does not treat an unrelated variable as configuration', () => {
    expect(readSettings({ SOMETHING_ELSE: 'value' })).toBeNull();
  });
});
