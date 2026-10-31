/**
 * The one Firebase app instance.
 *
 * Settings parsing lives in `settings.ts`, which imports nothing — this file
 * exists only to hold the SDK call, so that reading a config in a test never
 * loads the Firebase packages.
 */

import { initializeApp, type FirebaseApp } from 'firebase/app';
import type { FirebaseSettings } from './settings';

export type { FirebaseSettings } from './settings';
export { readSettings } from './settings';

let app: FirebaseApp | null = null;

/**
 * The app, created on first use and reused after.
 *
 * Both the auth provider and the Firestore store need it, and
 * `initializeApp` throws on a second call with the same default name — so
 * memoising here is what lets those two be constructed independently.
 */
export function firebaseApp(settings: FirebaseSettings): FirebaseApp {
  app ??= initializeApp(settings);
  return app;
}
