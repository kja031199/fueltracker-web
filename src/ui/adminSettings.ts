/**
 * Settings the administrator makes for everyone, read once at build time
 * (#70).
 *
 * Each is a repository **Variable** passed to the build by
 * `.github/workflows/deploy.yml`, next to the Firebase web config, and inlined
 * by Vite. Changing one means changing the Variable and redeploying; a tab
 * that is already open keeps the old value until the service worker updates
 * it. Nobody can change these from inside the app — that is the point.
 *
 * An unset Variable reaches the build as an empty string, and every value is
 * parsed so that a missing or malformed one falls back to a safe default
 * rather than switching anything off (`idleMinutesFromConfig`).
 */

import { idleMinutesFromConfig } from '../domain/idleTimeout';

/** Minutes of inactivity before anyone is signed out: `VITE_IDLE_TIMEOUT_MINUTES`. */
export const ADMIN_IDLE_MINUTES: number = idleMinutesFromConfig(import.meta.env.VITE_IDLE_TIMEOUT_MINUTES);
