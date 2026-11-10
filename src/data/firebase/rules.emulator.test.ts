/**
 * Does `firestore.rules` actually keep people out of each other's data?
 *
 * ## Why this file is separate
 *
 * It needs the Firestore emulator running, which needs Java and a downloaded
 * emulator JAR. The rest of the suite needs nothing but Node, and that is
 * worth protecting — so the `*.emulator.test.ts` files are a project of their
 * own (#97), which `npm test` does not run and a dedicated CI job does.
 *
 * Run them locally with:
 *
 * ```
 * npm ci --prefix .github/firebase-cli
 * npm run test:rules
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

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeStore } from '../../test/fixtures';
import { allowedUidsInRules, rulesEnvironment } from '../../test/emulator';
import {
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  Bytes,
  Timestamp,
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  where,
  type Firestore,
} from 'firebase/firestore';
import { InMemoryRepository } from '../repository';
import type { FillUpRecord, PendingFillUpRecord, VehicleRecord } from '../records';
import { FuelTrackerStore } from '../store';
import { makeFuelEntryDraft } from '../../domain/fuelEntryDraft';
import { syncOnce } from '../sync';
import { FirestoreRemoteStore } from './remoteStore';
import { InMemorySyncState } from '../syncState';



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

/** A second allowed account, when the deployment has one. */
const SECOND = ALLOWED[1];

describe('firestore.rules', () => {
  let env: RulesTestEnvironment;

  beforeAll(async () => {
    env = await rulesEnvironment('fueltracker-rules-test');
  });

  afterAll(async () => {
    await env?.cleanup();
  });

  it('lets someone read their own fill-up', async () => {
    const db = env.authenticatedContext(OWNER).firestore();
    await assertSucceeds(getDoc(doc(db, `users/${OWNER}/fillUps/f1`)));
  });

  it('reads nobody\'s account document itself, the owner\'s included (#92)', async () => {
    // The app reads only what is under it. A rule that allowed this covered a
    // document that is never written, and was one more rule to keep right.
    const db = env.authenticatedContext(OWNER).firestore();
    await assertFails(getDoc(doc(db, `users/${OWNER}`)));
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

    // Runs only when the deployment allows more than one account. With a single
    // entry there is no second allowed identity to test against, and the
    // uid-shaped-path test above covers the scoping question in that case.
    it.runIf(SECOND !== undefined)(
      'keeps two allowed accounts out of each other\'s data',
      async () => {
        // The strongest form of the scoping assertion, and only possible with
        // two entries: both parties are through the door, so the allowlist
        // cannot be what refuses this — only `request.auth.uid == uid` can.
        const db = env.authenticatedContext(SECOND!).firestore();
        await assertFails(getDoc(doc(db, `users/${OWNER}/fillUps/f1`)));
        await assertFails(
          setDoc(doc(db, `users/${OWNER}/vehicles/v1`), {
            id: 'v1',
            updatedAt: 1,
            deletedAt: null,
            schemaVersion: 1,
            name: 'Not yours',
            make: '',
            model: '',
            year: 2020,
            createdAt: 1,
          }),
        );
      },
    );

    it.runIf(SECOND !== undefined)('lets the second allowed account use its own tree', async () => {
      const db = env.authenticatedContext(SECOND!).firestore();
      await assertSucceeds(getDoc(doc(db, `users/${SECOND}/fillUps/f1`)));
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
        // Every write carries the server's stamp since #52, so every positive
        // case does too — and every negative case differs only in what it
        // means to test.
        syncedAt: serverTimestamp(),
      };
    }

    it('accepts a vehicle exactly as the app writes it', async () => {
      const { vehicle } = await realRecords();
      const db = env.authenticatedContext(OWNER).firestore();
      await assertSucceeds(setDoc(doc(db, `users/${OWNER}/vehicles/${vehicle.id}`), { ...vehicle, syncedAt: serverTimestamp() }));
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

  describe('an allowed owner with an over-long field (#50)', () => {
    /**
     * The exact failure, against the real rules: a 201-character station name
     * failed the whole batch with `permission-denied`, sync called that an
     * access refusal, and the owner was locked out with 0 of 3 documents
     * uploaded. Driven through the real `syncOnce`, the real store and — since
     * #52 — the real `FirestoreRemoteStore`, handed the emulator's
     * authenticated instance.
     */
    function emulatorRemote(): FirestoreRemoteStore {
      return FirestoreRemoteStore.over(env.authenticatedContext(OWNER).firestore() as unknown as Firestore, OWNER);
    }

    it('uploads every row, shortened to what the rules accept', async () => {
      await env.clearFirestore();
      const store = makeStore();
      const vehicle = await store.addVehicle({ name: 'Car' });
      const base = { odometer: 1000, gallons: 10, pricePerGallon: 3 };
      await store.addFillUp(makeFuelEntryDraft({ ...base, date: new Date(2026, 0, 1) })!, vehicle.id);
      await store.addFillUp(
        makeFuelEntryDraft({ ...base, odometer: 1300, date: new Date(2026, 0, 8), station: 'x'.repeat(201) })!,
        vehicle.id,
      );

      const result = await syncOnce(store, emulatorRemote(), new InMemorySyncState());

      expect(result.ok).toBe(true);
      const db = env.authenticatedContext(OWNER).firestore();
      const fillUps = (await getDocs(collection(db, 'users', OWNER, 'fillUps'))).docs.map((d) => d.data());
      expect(fillUps).toHaveLength(2);
      expect(fillUps.map((row) => (row['station'] as string).length).sort()).toEqual([0, 200]);
    });

    it('uploads more rows than one batch holds, every batch of them (#91)', async () => {
      // Firestore takes at most 500 writes a batch; a long history is several.
      await env.clearFirestore();
      const store = makeStore();
      const vehicle = await store.addVehicle({ name: 'Car' });
      for (let i = 0; i < 520; i += 1) {
        await store.addFillUp(
          makeFuelEntryDraft({ odometer: 1000 + i, gallons: 10, pricePerGallon: 3, date: new Date(2026, 0, 1) })!,
          vehicle.id,
        );
      }

      const result = await syncOnce(store, emulatorRemote(), new InMemorySyncState());

      expect(result.ok && result.outcome.pushed.written).toBe(521);
      const db = env.authenticatedContext(OWNER).firestore();
      expect((await getDocs(collection(db, 'users', OWNER, 'fillUps'))).size).toBe(520);
    }, 30_000);

    it('repairs a row stored too long by an older build, then uploads it', async () => {
      await env.clearFirestore();
      const vehicle: VehicleRecord = {
        id: 'v1', updatedAt: 500, deletedAt: null, schemaVersion: 1,
        name: 'Car', make: '', model: '', year: 2020, createdAt: 500,
      };
      const legacy: FillUpRecord = {
        id: 'f1', updatedAt: 500, deletedAt: null, schemaVersion: 1, vehicleId: 'v1',
        date: 1_700_000_000_000, odometer: 1000, gallons: 10, pricePerGallon: 3, isFullTank: true,
        missedPreviousFillUp: false, fuelGrade: 'Regular', station: 'x'.repeat(201),
        notes: 'n'.repeat(4001), latitude: null, longitude: null, receiptImageData: null,
      };
      // Written straight into the repositories, as an older build would have.
      const store = new FuelTrackerStore({
        vehicles: new InMemoryRepository<VehicleRecord>([vehicle]),
        fillUps: new InMemoryRepository<FillUpRecord>([legacy]),
        pendingFillUps: new InMemoryRepository<PendingFillUpRecord>(),
      });

      const result = await syncOnce(store, emulatorRemote(), new InMemorySyncState());

      expect(result.ok).toBe(true);
      const db = env.authenticatedContext(OWNER).firestore();
      const stored = (await getDoc(doc(db, 'users', OWNER, 'fillUps', 'f1'))).data();
      expect((stored?.['station'] as string).length).toBe(200);
      expect((stored?.['notes'] as string).length).toBe(4000);
    });
  });

  describe('the server stamp incremental sync reads by (#52)', () => {
    async function aFillUp(): Promise<FillUpRecord> {
      const store = makeStore();
      const vehicle = await store.addVehicle({ name: 'Car' });
      return store.addFillUp(
        makeFuelEntryDraft({ date: new Date(2026, 0, 1), odometer: 1000, gallons: 10, pricePerGallon: 3 })!,
        vehicle.id,
      );
    }

    function wire(row: FillUpRecord): Record<string, unknown> {
      return { ...row, receiptImageData: null, syncedAt: serverTimestamp() };
    }

    it('refuses a write without the stamp', async () => {
      // Strict on purpose. A write without it would be invisible to every
      // incremental read — on every other device, for good. An out-of-date
      // copy of the app is refused instead, keeps the change on its device,
      // and sends it once it updates.
      const row = await aFillUp();
      const db = env.authenticatedContext(OWNER).firestore();
      const { syncedAt: _omitted, ...unstamped } = wire(row);
      await assertFails(setDoc(doc(db, `users/${OWNER}/fillUps/${row.id}`), unstamped));
    });

    it('refuses a stamp the client chose', async () => {
      // A client-supplied time could sit below another device's cursor and
      // never be read. Only the server's own clock is trusted.
      const row = await aFillUp();
      const db = env.authenticatedContext(OWNER).firestore();
      await assertFails(
        setDoc(doc(db, `users/${OWNER}/fillUps/${row.id}`), { ...wire(row), syncedAt: Timestamp.fromMillis(0) }),
      );
    });

    it('accepts the server stamp', async () => {
      const row = await aFillUp();
      const db = env.authenticatedContext(OWNER).firestore();
      await assertSucceeds(setDoc(doc(db, `users/${OWNER}/fillUps/${row.id}`), wire(row)));
    });

    it('refuses an incremental read of somebody else’s tree', async () => {
      const db = env.authenticatedContext(STRANGER).firestore();
      await assertFails(
        getDocs(query(collection(db, `users/${OWNER}/fillUps`), where('syncedAt', '>', Timestamp.fromMillis(0)))),
      );
    });

    it('the real remote reads back only what changed since its cursor', async () => {
      await env.clearFirestore();
      const remote = FirestoreRemoteStore.over(
        env.authenticatedContext(OWNER).firestore() as unknown as Firestore,
        OWNER,
      );
      const first = await aFillUp();
      await remote.push({ vehicles: [], fillUps: [first], pendingFillUps: [] });

      const full = await remote.pull(null);
      expect(full.fillUps).toHaveLength(1);
      expect(full.highWater?.fillUps).toEqual(expect.any(Number));
      // The stamp is the remote's business: records never carry it.
      expect(full.fillUps[0]).not.toHaveProperty('syncedAt');

      const quiet = await remote.pull(full.highWater ?? null);
      expect(quiet.fillUps).toHaveLength(0);

      const second = await aFillUp();
      await remote.push({ vehicles: [], fillUps: [second], pendingFillUps: [] });
      const changed = await remote.pull(full.highWater ?? null);
      expect((changed.fillUps as FillUpRecord[]).map((row) => row.id)).toEqual([second.id]);
    });

    it('two syncs through the real remote: the second downloads nothing new', async () => {
      await env.clearFirestore();
      const remote = FirestoreRemoteStore.over(
        env.authenticatedContext(OWNER).firestore() as unknown as Firestore,
        OWNER,
      );
      const store = makeStore();
      await store.addVehicle({ name: 'Car' });
      const state = new InMemorySyncState();

      const first = await syncOnce(store, remote, state);
      const second = await syncOnce(store, remote, state);
      const third = await syncOnce(store, remote, state);

      expect(first.ok && second.ok && third.ok).toBe(true);
      if (!third.ok) return;
      expect(third.outcome.pulled.vehiclesWritten + third.outcome.pulled.skippedOlder).toBe(0);
    });
  });
  // #79. Last-write-wins on `updatedAt` only works if nobody can claim a time
  // no honest device could have: one far-future stamp made a fill-up
  // impossible for anyone else to edit or delete, for good.
  describe('the merge stamp is bounded (#79)', () => {
    const DAY = 24 * 60 * 60 * 1000;

    async function aFillUp(): Promise<FillUpRecord> {
      const store = makeStore();
      const vehicle = await store.addVehicle({ name: 'Car' });
      return store.addFillUp(
        makeFuelEntryDraft({ date: new Date(2026, 0, 1), odometer: 1000, gallons: 10, pricePerGallon: 3 })!,
        vehicle.id,
      );
    }

    function wire(row: FillUpRecord, patch: Record<string, unknown> = {}): Record<string, unknown> {
      return { ...row, receiptImageData: null, syncedAt: serverTimestamp(), ...patch };
    }

    function ownDb() {
      return env.authenticatedContext(OWNER).firestore();
    }

    it('refuses a stamp a year ahead — the lock in #79', async () => {
      const row = await aFillUp();
      await assertFails(setDoc(doc(ownDb(), `users/${OWNER}/fillUps/${row.id}`), wire(row, { updatedAt: Date.now() + 365 * DAY })));
    });

    it('accepts one 29 days ahead: a fast clock, within what the app itself adopts', async () => {
      const row = await aFillUp();
      await assertSucceeds(setDoc(doc(ownDb(), `users/${OWNER}/fillUps/${row.id}`), wire(row, { updatedAt: Date.now() + 29 * DAY })));
    });

    it('refuses taking a document’s stamp backwards', async () => {
      const row = await aFillUp();
      const ref = doc(ownDb(), `users/${OWNER}/fillUps/${row.id}`);
      await assertSucceeds(setDoc(ref, wire(row, { updatedAt: 5_000 })));
      await assertFails(setDoc(ref, wire(row, { updatedAt: 4_999, odometer: 1001 })));
    });

    it('accepts the same stamp again — a re-send — and a newer one', async () => {
      const row = await aFillUp();
      const ref = doc(ownDb(), `users/${OWNER}/fillUps/${row.id}`);
      await assertSucceeds(setDoc(ref, wire(row, { updatedAt: 5_000 })));
      await assertSucceeds(setDoc(ref, wire(row, { updatedAt: 5_000 })));
      await assertSucceeds(setDoc(ref, wire(row, { updatedAt: 5_001, odometer: 1001 })));
    });

    it('a new document has no lower bound', async () => {
      const row = await aFillUp();
      await assertSucceeds(setDoc(doc(ownDb(), `users/${OWNER}/fillUps/${row.id}`), wire(row, { updatedAt: 1 })));
    });

    it.each([
      ['updatedAt', Number.NaN],
      ['updatedAt', Number.POSITIVE_INFINITY],
      ['deletedAt', Number.NaN],
      ['deletedAt', Number.POSITIVE_INFINITY],
      ['date', Number.NaN],
      ['odometer', Number.POSITIVE_INFINITY],
      ['gallons', Number.NaN],
      ['pricePerGallon', Number.NEGATIVE_INFINITY],
      ['latitude', Number.NaN],
      ['longitude', Number.POSITIVE_INFINITY],
    ])('refuses %s = %s: every number is finite', async (field, value) => {
      const row = await aFillUp();
      await assertFails(setDoc(doc(ownDb(), `users/${OWNER}/fillUps/${row.id}`), wire(row, { [field]: value })));
    });
  });
});
