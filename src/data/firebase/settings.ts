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
