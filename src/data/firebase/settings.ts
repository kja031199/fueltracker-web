/**
 * Reading the Firebase project settings out of the environment.
 *
 * Separate from `config.ts` so that parsing the settings drags in no SDK: this
 * file imports nothing, which is what lets it be tested directly without the
 * Firebase packages being loaded at all.
 *
 * ## Why these values live in the environment
 *
 * A Firebase web config is **not a secret**. Google documents it as public, and
 * it necessarily ships inside the JavaScript bundle where anyone can read it.
 * What protects the data is `firestore.rules`, not the obscurity of the key.
 *
 * It still does not get committed, for two practical reasons:
 *
 * 1. The `apiKey` matches gitleaks' Google-API-key pattern (`AIza…`), so
 *    committing it reddens the secret-scan job. The remedy would be
 *    allowlisting a credential pattern, and this project's own policy
 *    (`.gitleaks.toml`) is that allowlisting is never the fix.
 * 2. It keeps a fork pointed at its own project rather than silently writing
 *    into this one.
 */

export interface FirebaseSettings {
  readonly apiKey: string;
  readonly authDomain: string;
  readonly projectId: string;
  readonly appId: string;
}

const REQUIRED = ['apiKey', 'authDomain', 'projectId', 'appId'] as const;

/**
 * Reads the config, or returns `null` when it is absent or incomplete.
 *
 * `null` is a supported state, not an error: a checkout with no `.env.local`
 * must still start, typecheck and run its tests. The app then reports that it
 * is unconfigured, rather than throwing during module evaluation — which would
 * produce a blank page and a console message, the least diagnosable failure
 * there is.
 *
 * **Partial counts as absent.** Three values out of four cannot sign anyone in,
 * and a half-configured build that renders a live-looking button is worse than
 * one that says plainly what is missing.
 */
export function readSettings(
  env: Record<string, string | undefined>,
): FirebaseSettings | null {
  const settings: FirebaseSettings = {
    apiKey: env.VITE_FIREBASE_API_KEY ?? '',
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN ?? '',
    projectId: env.VITE_FIREBASE_PROJECT_ID ?? '',
    appId: env.VITE_FIREBASE_APP_ID ?? '',
  };
  // Trimmed, because a `.env` line written as `VITE_FIREBASE_APP_ID= ` yields a
  // single space, which is not a configuration but would pass an emptiness test.
  if (REQUIRED.some((key) => settings[key].trim() === '')) return null;
  return settings;
}

/**
 * The project the live site is deployed from.
 *
 * Named here rather than read from the environment because the guard below
 * exists to stop the environment being wrong: a value that came from
 * `.env.local` could not protect against `.env.local`.
 */
export const PRODUCTION_PROJECT_ID = 'fueltracker-899eb';

/**
 * Whether a page served from `hostname` is running on the developer's own
 * machine: `localhost` and its subdomains, the IPv4 loopback block, IPv6
 * loopback (bracketed, as `location.hostname` gives it, or bare), and the
 * all-interfaces address some dev servers print.
 *
 * Every pattern is anchored at both ends: `localhost.example.com` and
 * `127.0.0.1.nip.io` are somebody else's servers.
 */
export function isLocalHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    /^127(\.\d{1,3}){3}$/.test(host) ||
    host === '::1' ||
    host === '[::1]' ||
    host === '0.0.0.0'
  );
}

/**
 * True when a development build is about to use the production project.
 *
 * Issue #45. Local development used to sign in to and sync with the real fuel
 * log, so a bug in an unreviewed change — a tombstone scrub, an id rule, a sync
 * edit — ran against production data before a PR existed. This refuses that
 * pairing, and deliberately has no override: an escape hatch is the first
 * thing a hurried evening reaches for.
 *
 * Two signals, because either alone misses a case:
 * - `dev` (Vite's `import.meta.env.DEV`) catches the dev server even when it is
 *   reached on a LAN address with `vite --host`.
 * - the hostname catches `vite preview`, which serves the *production* bundle
 *   — `dev` false — on the developer's machine.
 *
 * The deployed site has neither, so it is unaffected. The project id is
 * compared trimmed and lower-cased so a stray space in `.env.local` cannot
 * slip past it.
 */
export function developmentUsesProduction(
  settings: FirebaseSettings,
  where: { readonly dev: boolean; readonly hostname: string },
): boolean {
  if (settings.projectId.trim().toLowerCase() !== PRODUCTION_PROJECT_ID) return false;
  return where.dev || isLocalHostname(where.hostname);
}
