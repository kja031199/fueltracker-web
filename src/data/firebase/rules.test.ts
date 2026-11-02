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
import { Bytes, doc, getDoc, setDoc } from 'firebase/firestore';
import { InMemoryRepository } from '../repository';
import type { FillUpRecord, PendingFillUpRecord, VehicleRecord } from '../records';
import { FuelTrackerStore } from '../store';
import { makeFuelEntryDraft } from '../../domain/fuelEntryDraft';

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
// `describe.skipIf` rather than a thrown error: a checkout without the
// emulator must still get a green suite, or everyone learns to ignore red.
const describeWithEmulator = describe.skipIf(HOST === undefined);

/**
 * The accounts the deployed rules allow, read out of the rules file itself.
 *
 * Parsed rather than duplicated, so this suite keeps testing whatever is
 * actually deployed: add a person to the allowlist and these tests still pass
 * unchanged, empty it and `the allowlist itself` below fails loudly. A regex
 * over the rules is crude, and the alternative — a second copy of the list in
 * the tests — is worse, because the copy that drifts is the one nobody checks.
 */
function allowedUidsInRules(): string[] {
  const source = readFileSync('firestore.rules', 'utf8');
  const block = /function allowed\(\)[\s\S]*?\[([\s\S]*?)\]/.exec(source);
  if (block === null) {
    throw new Error('firestore.rules has no allowed() list — has the allowlist been removed?');
  }
  return [...block[1]!.matchAll(/'([^']*)'/g)].map((match) => match[1]!);
}

const ALLOWED = allowedUidsInRules();

/** The first allowed account. Every positive test signs in as this one. */
const OWNER = ALLOWED[0] ?? 'nobody-is-allowed';

/**
 * A signed-in account that is **not** on the allowlist.
 *
 * Deliberately used for two different jobs below, which the tests keep apart:
 * reading somebody else's tree (which the uid match refuses) and reading its
 * own (which only the allowlist refuses).
 */
const STRANGER = 'uid-that-is-not-on-the-allowlist';

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
    const db = env.authenticatedContext(OWNER).firestore();
    await assertSucceeds(getDoc(doc(db, `users/${OWNER}/fillUps/f1`)));
  });

  it('refuses a shapeless write even to your own tree', async () => {
    // This test used to assert the opposite — that `{ gallons: 10 }` was
    // accepted — because identity was the only question the rules asked. Owning
    // the path is no longer sufficient: a document that is not a record cannot
    // be reconciled, and letting one in means the read path meets it later.
    // The positive case now lives in "the shape of what gets written", against
    // records the app actually produces.
    const db = env.authenticatedContext(OWNER).firestore();
    await assertFails(setDoc(doc(db, `users/${OWNER}/fillUps/f1`), { gallons: 10 }));
  });

  it('refuses to let one person read another person’s fill-up', async () => {
    // The whole point of the file.
    const db = env.authenticatedContext(STRANGER).firestore();
    await assertFails(getDoc(doc(db, `users/${OWNER}/fillUps/f1`)));
  });

  it('refuses to let one person write into another person’s log', async () => {
    const db = env.authenticatedContext(STRANGER).firestore();
    await assertFails(setDoc(doc(db, `users/${OWNER}/fillUps/f1`), { gallons: 999 }));
  });

  it('refuses an unauthenticated read', async () => {
    // `request.auth` is null here, which is why the rule checks for null
    // before reading `.uid` off it — that comparison would otherwise error
    // rather than deny.
    const db = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, `users/${OWNER}/fillUps/f1`)));
  });

  it('refuses a read of a uid-shaped path that is not a real owner', async () => {
    // Note which conjunct this isolates: the reader **is** on the allowlist,
    // so the only thing that can refuse it is `request.auth.uid == uid`. That
    // keeps per-account scoping independently proven now that a second rule
    // guards the door.
    const db = env.authenticatedContext(OWNER).firestore();
    await assertFails(getDoc(doc(db, `users/${OWNER}-evil-twin/fillUps/f1`)));
  });

  describe('the allowlist', () => {
    /**
     * Issue #27. Sign-in was open to every Google account on earth: the rules
     * confined a stranger to their own tree, and then let them keep writing in
     * it — on this project's quota, inside this project's 1 GiB, invisible to
     * the owner because nobody can see anybody else's tree. Being bounded to
     * your own corner is not the same as being allowed in.
     *
     * These two tests are the ones that isolate the new clause: the subject is
     * reading and writing **its own** tree, so scoping cannot be what refuses
     * it.
     */

    it('refuses an account that is not on it, even in its own tree', async () => {
      const db = env.authenticatedContext(STRANGER).firestore();
      await assertFails(getDoc(doc(db, `users/${STRANGER}/fillUps/f1`)));
    });

    it('refuses that account a write to its own tree as well', async () => {
      const db = env.authenticatedContext(STRANGER).firestore();
      await assertFails(
        setDoc(doc(db, `users/${STRANGER}/vehicles/v1`), {
          id: 'v1',
          updatedAt: 1,
          deletedAt: null,
          schemaVersion: 1,
          name: 'Squatter',
          make: '',
          model: '',
          year: 2020,
          createdAt: 1,
        }),
      );
    });

    it('is not empty, or nobody can use the deployment at all', async () => {
      expect(ALLOWED.length).toBeGreaterThan(0);
    });

    it('holds real uids rather than a placeholder', async () => {
      // The guard that keeps a half-finished allowlist off `main`. A rules file
      // whose list still says REPLACE_WITH_… is not "switched off", it is
      // switched on and admitting nobody — which locks the owner out of their
      // own data on the next deploy. This check is red until a real uid is in,
      // and it is a required check.
      for (const entry of ALLOWED) {
        expect(entry).not.toMatch(/replace|placeholder|todo|example|your[-_]?uid/i);
        // Firebase uids are 28 characters; anything short is a typo or a stub.
        expect(entry.length).toBeGreaterThanOrEqual(20);
        expect(entry).not.toMatch(/\s/);
      }
    });
  });

  it('applies the same rule to every collection under a user', async () => {
    // The layout exists so one rule covers all three collections, now and for
    // anything added later. This checks that claim rather than assuming it.
    const stranger = env.authenticatedContext(STRANGER).firestore();
    await assertFails(getDoc(doc(stranger, `users/${OWNER}/vehicles/v1`)));
    await assertFails(getDoc(doc(stranger, `users/${OWNER}/pendingFillUps/p1`)));
  });

  it('denies a collection outside the users tree', async () => {
    // Nothing matches it, and Firestore's default is deny — but "I believe the
    // default is deny" is exactly the kind of belief that should be measured.
    const db = env.authenticatedContext(OWNER).firestore();
    await assertFails(getDoc(doc(db, 'anythingElse/x')));
  });

  it('denies an unrecognised collection inside the users tree', async () => {
    // The rules name three collections. Anything else under a user's own tree
    // is still denied, so a stray write cannot invent a place to put data the
    // read path knows nothing about.
    const db = env.authenticatedContext(OWNER).firestore();
    await assertFails(setDoc(doc(db, `users/${OWNER}/somethingElse/x`), { id: 'x' }));
  });

  describe('the shape of what gets written', () => {
    /**
     * Records built by the app itself, not by hand.
     *
     * This matters more than it looks. A hand-written literal in a test drifts
     * from the real record the moment a field is added, and the test keeps
     * passing while production writes start being refused. Generating the
     * fixtures through `FuelTrackerStore` means the rules are checked against
     * exactly what the app pushes.
     */
    async function realRecords(): Promise<{
      vehicle: VehicleRecord;
      fillUp: FillUpRecord;
      tombstone: FillUpRecord;
      pending: PendingFillUpRecord;
    }> {
      const repos = {
        vehicles: new InMemoryRepository<VehicleRecord>(),
        fillUps: new InMemoryRepository<FillUpRecord>(),
        pendingFillUps: new InMemoryRepository<PendingFillUpRecord>(),
      };
      const store = new FuelTrackerStore(repos);
      const vehicle = await store.addVehicle({ name: 'Civic', make: 'Honda', model: 'Civic', year: 2019 });

      const draft = makeFuelEntryDraft({
        date: new Date(1_700_000_000_000),
        odometer: 10_000,
        gallons: 10,
        pricePerGallon: 3.5,
        station: 'Shell',
      });
      if (draft === null) throw new Error('fixture draft failed validation');
      const fillUp = await store.addFillUp(draft, vehicle.id);

      const doomed = await store.addFillUp(draft, vehicle.id);
      await store.removeFillUp(doomed.id);
      const tombstone = (await repos.fillUps.listDeleted())[0];
      if (tombstone === undefined) throw new Error('fixture tombstone missing');

      const pending = await store.submitFillUp(draft, vehicle.id, 'Sam');

      return { vehicle, fillUp, tombstone, pending };
    }

    /** Firestore holds receipt bytes as `Bytes`, so the fixture must too. */
    function forWire(record: FillUpRecord | PendingFillUpRecord): object {
      const bytes = record.receiptImageData;
      return {
        ...record,
        receiptImageData: bytes === null ? null : Bytes.fromUint8Array(bytes),
      };
    }

    it('accepts a vehicle exactly as the app writes it', async () => {
      const { vehicle } = await realRecords();
      const db = env.authenticatedContext(OWNER).firestore();
      await assertSucceeds(setDoc(doc(db, `users/${OWNER}/vehicles/${vehicle.id}`), { ...vehicle }));
    });

    it('accepts a fill-up exactly as the app writes it', async () => {
      const { fillUp } = await realRecords();
      const db = env.authenticatedContext(OWNER).firestore();
      await assertSucceeds(setDoc(doc(db, `users/${OWNER}/fillUps/${fillUp.id}`), forWire(fillUp)));
    });

    it('accepts a tombstone, which carries no usable measurements', async () => {
      const { tombstone } = await realRecords();
      const db = env.authenticatedContext(OWNER).firestore();
      await assertSucceeds(
        setDoc(doc(db, `users/${OWNER}/fillUps/${tombstone.id}`), forWire(tombstone)),
      );
    });

    it('accepts a submission exactly as the app writes it', async () => {
      const { pending } = await realRecords();
      const db = env.authenticatedContext(OWNER).firestore();
      await assertSucceeds(
        setDoc(doc(db, `users/${OWNER}/pendingFillUps/${pending.id}`), forWire(pending)),
      );
    });

    it('refuses a document filed under an id that disagrees with its own', async () => {
      // A row stored under the wrong name is a row a merge would reconcile
      // against the wrong history.
      const { fillUp } = await realRecords();
      const db = env.authenticatedContext(OWNER).firestore();
      await assertFails(setDoc(doc(db, `users/${OWNER}/fillUps/some-other-id`), forWire(fillUp)));
    });

    it('already refuses an id that is not a document name, with no new clause', async () => {
      // #26 asked whether the rules should check the id's characters too. They
      // do not need to, and this is the evidence rather than the argument: a
      // document name is a single path segment and can never contain a slash,
      // and `data.id == id` makes a field disagreeing with its own name a
      // refused write. So the one shape that breaks a push is already
      // unwritable, and the reserved names (`.`, `..`, `__…__`) are refused by
      // the database itself.
      const { fillUp } = await realRecords();
      const db = env.authenticatedContext(OWNER).firestore();
      await assertFails(
        setDoc(doc(db, `users/${OWNER}/fillUps/legal-name`), { ...forWire(fillUp), id: 'a/b' }),
      );
    });

    it('refuses an unknown extra field', async () => {
      // This is the quota protection: without it, a junk field can be inflated
      // to the 1 MiB document cap.
      const { fillUp } = await realRecords();
      const db = env.authenticatedContext(OWNER).firestore();
      await assertFails(
        setDoc(doc(db, `users/${OWNER}/fillUps/${fillUp.id}`), {
          ...forWire(fillUp),
          somethingElse: 'x'.repeat(1000),
        }),
      );
    });

    it('refuses a half-written document', async () => {
      const { fillUp } = await realRecords();
      const partial = { ...forWire(fillUp) } as Record<string, unknown>;
      delete partial.odometer;
      const db = env.authenticatedContext(OWNER).firestore();
      await assertFails(setDoc(doc(db, `users/${OWNER}/fillUps/${fillUp.id}`), partial));
    });

    it.each([
      ['a string date', { date: 'yesterday' }],
      ['a string odometer', { odometer: '10000' }],
      ['a non-boolean full-tank flag', { isFullTank: 'yes' }],
      ['an object vehicleId', { vehicleId: { id: 'v1' } }],
      ['an empty vehicleId', { vehicleId: '' }],
      ['a non-string station', { station: 42 }],
    ])('refuses %s', async (_label, override) => {
      const { fillUp } = await realRecords();
      const db = env.authenticatedContext(OWNER).firestore();
      await assertFails(
        setDoc(doc(db, `users/${OWNER}/fillUps/${fillUp.id}`), { ...forWire(fillUp), ...override }),
      );
    });

    it('refuses notes longer than the bound', async () => {
      const { fillUp } = await realRecords();
      const db = env.authenticatedContext(OWNER).firestore();
      await assertFails(
        setDoc(doc(db, `users/${OWNER}/fillUps/${fillUp.id}`), {
          ...forWire(fillUp),
          notes: 'n'.repeat(4001),
        }),
      );
    });

    it('refuses a receipt larger than one document should carry', async () => {
      // The app pushes an oversized receipt with the image omitted rather than
      // attempting this, so reaching the rule means something other than the
      // app is writing.
      const { fillUp } = await realRecords();
      const db = env.authenticatedContext(OWNER).firestore();
      await assertFails(
        setDoc(doc(db, `users/${OWNER}/fillUps/${fillUp.id}`), {
          ...forWire(fillUp),
          receiptImageData: Bytes.fromUint8Array(new Uint8Array(800 * 1024)),
        }),
      );
    });

    it('still refuses all of that in someone else’s tree', async () => {
      // Shape validation must not have accidentally become the only check.
      const { fillUp } = await realRecords();
      const db = env.authenticatedContext(STRANGER).firestore();
      await assertFails(setDoc(doc(db, `users/${OWNER}/fillUps/${fillUp.id}`), forWire(fillUp)));
    });
  });
});
