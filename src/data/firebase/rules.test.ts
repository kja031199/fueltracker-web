/**
 * Does `firestore.rules` actually keep people out of each other's data?
 *
 * ## Why this file is separate, and skipped by default
 *
 * It needs the Firestore emulator running, which needs Java and a downloaded
 * emulator JAR. The other 645 assertions need nothing but Node, and that is
 * worth protecting — so this suite skips itself when the emulator is not there
 * rather than failing, and a dedicated CI job provides it.
 *
 * Run it locally with:
 *
 * ```
 * npx --yes firebase-tools emulators:exec --only firestore \
 *   "npx vitest run src/data/firebase/rules.test.ts"
 *
 * `firebase-tools`, not `firebase` — the latter is the SDK and has no binary.
 * ```
 *
 * ## Why it exists at all
 *
 * There is no server in this app, so no code path checks permission before a
 * read: `firestore.rules` is the entire security boundary. A reviewer reading
 * it and nodding is not verification — the rule is short precisely so it can be
 * verified, and this is the verification. The failure it guards against is not
 * subtle, it is catastrophic and silent: one wrong clause and every signed-in
 * person can read every other person's fuel log, with nothing in the UI, the
 * tests, or the logs behaving any differently.
 */

import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc } from 'firebase/firestore';

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
// `describe.skipIf` rather than a thrown error: a checkout without the
// emulator must still get a green suite, or everyone learns to ignore red.
const describeWithEmulator = describe.skipIf(HOST === undefined);

describeWithEmulator('firestore.rules', () => {
  let env: RulesTestEnvironment;

  beforeAll(async () => {
    const [host, port] = (HOST ?? 'localhost:8080').split(':');
    env = await initializeTestEnvironment({
      projectId: 'fueltracker-rules-test',
      firestore: {
        rules: readFileSync('firestore.rules', 'utf8'),
        host,
        port: Number(port),
      },
    });
  });

  afterAll(async () => {
    await env?.cleanup();
  });

  it('lets someone read their own fill-up', async () => {
    const db = env.authenticatedContext('alice').firestore();
    await assertSucceeds(getDoc(doc(db, 'users/alice/fillUps/f1')));
  });

  it('lets someone write their own fill-up', async () => {
    const db = env.authenticatedContext('alice').firestore();
    await assertSucceeds(setDoc(doc(db, 'users/alice/fillUps/f1'), { gallons: 10 }));
  });

  it('refuses to let one person read another person’s fill-up', async () => {
    // The whole point of the file.
    const db = env.authenticatedContext('bob').firestore();
    await assertFails(getDoc(doc(db, 'users/alice/fillUps/f1')));
  });

  it('refuses to let one person write into another person’s log', async () => {
    const db = env.authenticatedContext('bob').firestore();
    await assertFails(setDoc(doc(db, 'users/alice/fillUps/f1'), { gallons: 999 }));
  });

  it('refuses an unauthenticated read', async () => {
    // `request.auth` is null here, which is why the rule checks for null
    // before reading `.uid` off it — that comparison would otherwise error
    // rather than deny.
    const db = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'users/alice/fillUps/f1')));
  });

  it('refuses a read of a uid-shaped path that is not a real owner', async () => {
    const db = env.authenticatedContext('alice').firestore();
    await assertFails(getDoc(doc(db, 'users/alice-evil-twin/fillUps/f1')));
  });

  it('applies the same rule to every collection under a user', async () => {
    // The layout exists so one rule covers all three collections, now and for
    // anything added later. This checks that claim rather than assuming it.
    const bob = env.authenticatedContext('bob').firestore();
    await assertFails(getDoc(doc(bob, 'users/alice/vehicles/v1')));
    await assertFails(getDoc(doc(bob, 'users/alice/pendingFillUps/p1')));
  });

  it('denies a collection outside the users tree', async () => {
    // Nothing matches it, and Firestore's default is deny — but "I believe the
    // default is deny" is exactly the kind of belief that should be measured.
    const db = env.authenticatedContext('alice').firestore();
    await assertFails(getDoc(doc(db, 'anythingElse/x')));
  });
});
