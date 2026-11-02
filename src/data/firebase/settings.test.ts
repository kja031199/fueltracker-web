import { describe, expect, it } from 'vitest';
import {
  developmentUsesProduction,
  isLocalHostname,
  PRODUCTION_PROJECT_ID,
  readSettings,
  type FirebaseSettings,
} from './settings';

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

/**
 * Issue #45. A development build used to talk to the production project, so a
 * bug in an unreviewed change ran against the real fuel log before any PR
 * existed. The guard refuses that pairing outright; there is no override.
 */
describe('developmentUsesProduction', () => {
  const production: FirebaseSettings = {
    apiKey: 'test-key',
    authDomain: `${PRODUCTION_PROJECT_ID}.firebaseapp.com`,
    projectId: PRODUCTION_PROJECT_ID,
    appId: '1:2:web:3',
  };
  const development: FirebaseSettings = {
    ...production,
    authDomain: 'fueltracker-dev.firebaseapp.com',
    projectId: 'fueltracker-dev',
  };

  it('names the project the site is deployed from', () => {
    // Pinned, so a typo in the constant cannot quietly disarm the guard.
    expect(PRODUCTION_PROJECT_ID).toBe('fueltracker-899eb');
  });

  it('refuses production from the dev server, even on a LAN address', () => {
    // `vite --host` serves on the machine's network address, which no hostname
    // rule would recognise as local; the DEV flag is what catches it.
    expect(developmentUsesProduction(production, { dev: true, hostname: '192.168.1.20' })).toBe(true);
  });

  it.each(['localhost', '127.0.0.1', '127.1.2.3', '[::1]', '::1', '0.0.0.0', 'app.localhost', 'LOCALHOST'])(
    'refuses production from a production build served on %s',
    (hostname) => {
      // `vite preview` serves the production bundle — DEV is false — on the
      // developer's own machine. The hostname is what catches it.
      expect(developmentUsesProduction(production, { dev: false, hostname })).toBe(true);
    },
  );

  it.each([`${PRODUCTION_PROJECT_ID}.web.app`, `${PRODUCTION_PROJECT_ID}.firebaseapp.com`, `${PRODUCTION_PROJECT_ID}--pr-7-abc.web.app`])(
    'lets the deployed site at %s use production',
    (hostname) => {
      expect(developmentUsesProduction(production, { dev: false, hostname })).toBe(false);
    },
  );

  it('lets a development build use any other project', () => {
    expect(developmentUsesProduction(development, { dev: true, hostname: 'localhost' })).toBe(false);
  });

  it('sees through padding and case in the project id', () => {
    const padded = { ...production, projectId: ` ${PRODUCTION_PROJECT_ID.toUpperCase()} ` };
    expect(developmentUsesProduction(padded, { dev: true, hostname: 'localhost' })).toBe(true);
  });

  it('does not mistake a lookalike project for production', () => {
    const lookalike = { ...production, projectId: `${PRODUCTION_PROJECT_ID}-dev` };
    expect(developmentUsesProduction(lookalike, { dev: true, hostname: 'localhost' })).toBe(false);
  });
});

describe('isLocalHostname', () => {
  it.each(['localhost', 'foo.localhost', '127.0.0.1', '127.255.255.254', '[::1]', '::1', '0.0.0.0'])(
    'treats %s as this machine',
    (hostname) => {
      expect(isLocalHostname(hostname)).toBe(true);
    },
  );

  it.each([
    'localhost.example.com',
    'notlocalhost',
    '127.0.0.1.nip.io',
    '10.127.0.0.1',
    '192.168.1.20',
    'fueltracker-899eb.web.app',
    '',
  ])('does not treat %s as this machine', (hostname) => {
    expect(isLocalHostname(hostname)).toBe(false);
  });
});
