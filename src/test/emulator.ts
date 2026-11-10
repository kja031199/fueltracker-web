/**
 * What the Firestore emulator suites share (#97): whether there is an
 * emulator, the accounts the deployed rules allow, and a test environment
 * over the real `firestore.rules`. It was copied into three files.
 */

import { readFileSync } from 'node:fs';
import { describe } from 'vitest';
import { initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';

export const EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST;

/**
 * `describe`, skipped where no emulator runs. Skipped rather than failed: a
 * checkout without the emulator must still get a green suite, or everyone
 * learns to ignore red. CI runs these in a job of their own.
 */
export const describeWithEmulator = describe.skipIf(EMULATOR_HOST === undefined);

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
  const [host, port] = (EMULATOR_HOST ?? 'localhost:8080').split(':');
  return initializeTestEnvironment({
    projectId,
    firestore: { rules: readFileSync('firestore.rules', 'utf8'), host, port: Number(port) },
  });
}
