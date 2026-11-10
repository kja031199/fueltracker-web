/**
 * What the Firestore emulator suites share (#97): the accounts the deployed
 * rules allow, and a test environment over the real `firestore.rules`. It was
 * copied into three files.
 *
 * Only the `*.emulator.test.ts` files import it, and they run only in the
 * `rules` project, whose global setup (`needsEmulator.ts`) stops the run when
 * no emulator is there — so nothing here has to cope with a missing one.
 */

import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment,
  type RulesTestContext,
  type RulesTestEnvironment,
  type TokenOptions,
} from '@firebase/rules-unit-testing';

/**
 * The accounts the deployed rules allow, read out of the rules file itself.
 *
 * Parsed rather than duplicated, so the suites keep testing whatever is
 * actually deployed: add a person to the allowlist and they still pass
 * unchanged, empty it and the allowlist test fails loudly. A regex over the
 * rules is crude, and the alternative — a second copy of the list in the
 * tests — is worse, because the copy that drifts is the one nobody checks.
 */
export function allowedUidsInRules(): string[] {
  const source = readFileSync('firestore.rules', 'utf8');
  const block = /function allowed\(\)[\s\S]*?\[([\s\S]*?)\]/.exec(source);
  if (block === null) {
    throw new Error('firestore.rules has no allowed() list — has the allowlist been removed?');
  }
  return [...block[1]!.matchAll(/'([^']*)'/g)].map((match) => match[1]!);
}

/** A rules test environment over the real `firestore.rules`, on the running emulator. */
export function rulesEnvironment(projectId: string): Promise<RulesTestEnvironment> {
  const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST ?? '').split(':');
  return initializeTestEnvironment({
    projectId,
    firestore: { rules: readFileSync('firestore.rules', 'utf8'), host, port: Number(port) },
  });
}

/**
 * Signed in the way the app signs people in: with Google (#82).
 *
 * The rules accept only a Google sign-in, and the emulator's default token
 * claims a `custom` provider — so every context goes through here, and a test
 * that wants another provider says so in `claims`.
 */
export function signedIn(env: RulesTestEnvironment, uid: string, claims: TokenOptions = {}): RulesTestContext {
  return env.authenticatedContext(uid, { firebase: { sign_in_provider: 'google.com' }, ...claims });
}
