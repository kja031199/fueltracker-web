import { join } from 'node:path';

/**
 * What the rules and build projects need before they can run (#97), as plain
 * functions so the messages are tested without starting either.
 *
 * Each project **fails** without its prerequisite rather than skipping. A skip
 * is silent: these suites used to skip in every normal run, which taught
 * everyone that 84 skipped tests were normal — and a check that always skips
 * is barely different from one that was never written. Now `npm test` doesn't
 * run them at all, and the scripts that do (`test:rules`, `test:build`)
 * provide what they need, so reaching one of these messages means a project
 * was started some other way.
 */

/** Why the rules project cannot run, or `null` when an emulator is set. */
export function emulatorMissing(env: Readonly<Record<string, string | undefined>>): string | null {
  // Blank counts as unset: `FIRESTORE_EMULATOR_HOST=` in a shell is a typo,
  // not an emulator on an empty host.
  if ((env.FIRESTORE_EMULATOR_HOST ?? '').trim() !== '') return null;
  return (
    'The rules tests need the Firestore emulator, and FIRESTORE_EMULATOR_HOST is not set. ' +
    'Run them with `npm run test:rules`, which starts it (after `npm ci --prefix .github/firebase-cli`).'
  );
}

/** Why the build project cannot run, or `null` when there is a build to read. */
export function buildMissing(exists: (path: string) => boolean): string | null {
  if (exists(join('dist', 'index.html'))) return null;
  return (
    'The build tests read the built site, and dist/index.html does not exist. ' +
    'Run them with `npm run test:build`, which builds first.'
  );
}

/**
 * The error a global setup throws, carrying only its message.
 *
 * Its stack is set to the message up front. Vitest 5 maps a global setup's
 * stack through the module runner's source maps, and that crashes ("code.
 * charCodeAt is not a function") on the setup module — the run then reports
 * the crash and never shows why it stopped. A stack that is already a string
 * is never mapped, and nothing is lost: the reason is the message, not where
 * it was thrown.
 */
export function prerequisiteError(message: string): Error {
  const error = new Error(message);
  error.stack = message;
  return error;
}
