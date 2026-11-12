# CLAUDE.md

Operating manual for an AI assistant working in this repo: what it is, how to
work in it, the invariants nothing may break, and where every other rule lives.

**Keep it short** — `src/test/docs.test.ts` holds it to 160 lines. A rule about
one module goes in that module's docblock as an `@trap #N —` paragraph, where
somebody editing the code will read it. This file was 896 lines of retold
reasoning before #100, and nobody consulted it.

User-facing documentation is [`README.md`](README.md) and [`docs/`](docs/).
Where they disagree with this file, fix both.

## What this is

A browser rewrite of [FuelTracker](https://github.com/kja031199/FuelTrackingApp),
a frozen iOS + watchOS app that serves as the specification. React 19,
TypeScript 7, Vite, Dexie over IndexedDB, Firebase Auth and Firestore, deployed
to Firebase Hosting at `fueltracker-899eb.web.app`.

- `src/domain/` — pure logic: statistics, units, the draft gate, the scan
  parsers. Imports nothing from `data/` or `ui/`, nor React, Dexie or Firebase
  (`layering.test.ts`), and says nothing in English (`domainWords.test.ts`).
- `src/data/` — records and persistence: `store.ts` the write surface, `sync.ts`
  the reconciliation, `recordValidation.ts` the one decoder, `db.ts` the Dexie
  schema. No import cycles (`importCycles.test.ts`).
- `src/data/firebase/` — the **only** place the Firebase SDK is imported.
- `src/bootstrap.ts` — what loads when: Firestore only on sign-in.
- `src/ui/` — React. `fuelLog.tsx` owns the data, sync and every write;
  `AppShell.tsx` the tabs; `session.tsx` the units and session contexts.

No file or test counts here: they go stale a pull request later.

## How to work here

**Test first, and show the red.** Run the new test, see it fail for the right
reason, then implement. Put the failing run in the pull request. A pure
refactor is the exception: the suite passing unchanged is the assertion — say
so.

**Docs last.** Re-read `README.md`, `docs/` and this file against the diff
before opening the pull request; only then is it clear what changed.

**Every pull request that closes an issue adds a release note** to
[`RELEASE_NOTES.md`](RELEASE_NOTES.md), under today's UTC date
([how](docs/development.md#release-notes)).

**Mutation-test anything whose silent failure is expensive** — the rules,
account separation, the data boundary — and record each mutation as data in
`scripts/mutations/sets/` ([how](docs/development.md#mutation-testing)). A test
that cannot fail is decoration.

**Check exit codes directly.** `npm run typecheck | tail` reports *tail's*
status; that shipped a broken typecheck to `main` once.

**Everything runs here**: Node, the full suite, the Firestore emulator. The
commands are in [docs/development.md](docs/development.md#development); format
with `npm run format` before committing.

## Hard invariants

1. **Every fill-up is built from a `FuelEntryDraft`.** `addFillUp` takes a
   draft, so nothing can write an unvalidated entry; the gate rejects
   non-positive **and** non-finite numbers (`+Infinity` passes `> 0`). The
   copy between draft and record is written once, in `recordMapping.ts`.
2. **Nothing from the account is trusted.** Every pulled row goes through
   `recordValidation.ts`; `RemoteStore.pull()` returns `RawSnapshot` on
   purpose — do not "simplify" it to `Snapshot`. Files go through the same
   decoder; never add a second row parser.
3. **Deletions are tombstones carrying only the sync fields** (`tombstone.ts`).
   The one hard delete is `Repository.purge`, for `forgetVehicle` only.
4. **Storage is canonical** — miles, US gallons, US MPG — converted only at the
   display boundary. L/100km is the *reciprocal* of MPG.
5. **Local storage is per account**, `fueltracker-u-<uid>`, opened after auth
   resolves, and nothing that runs on sign-in moves data into an account. Every
   `localStorage` key goes through `ui/preferences.ts` with a declared scope.
6. **The Firebase SDK is imported only under `src/data/firebase/`**
   (`sdkBoundary.test.ts`), which keeps the suite offline and fast.
7. **The four sync fields are on every record**: client `id`, `updatedAt`,
   `deletedAt`, `schemaVersion`. They cannot be retrofitted over real data.
8. **Screens write through `useFuelLog()`, never the store.** Every write is
   built by `written` in `fuelLog.tsx` (store call, refresh, sync);
   `storeBoundary.test.ts` lists the files that may import the store.
9. **A shared car stays in its owner's tree.** A member's own sync excludes
   shared cars and each shared car's sync pushes only its fill-ups; an ended
   share is forgotten with no tombstone; the share ledger fails closed; and a
   share whose car id is already yours is never joined, synced or recorded.

## Where the rules are

Every other rule sits beside the code it governs, tagged with the issue that
made it. To list them all:

```bash
git grep -n '@trap'
```

Read the ones in a module before changing it. Narrow the list with a path
(`git grep -n '@trap' src/data`); `src/test` holds the rules for writing tests.
Rules that belong to no module are in [`docs/`](docs/README.md), mostly
[development.md](docs/development.md#testing-rules).

## Checks

Every change goes through a pull request: the required checks have no bypass
actors, **including for you**. What each one checks, and why it is safe to
require, is in [docs/development.md](docs/development.md#automated-checks).

## Before opening a pull request

- [ ] The test was written first and seen to fail, and the PR says so.
- [ ] Mutation-tested, if it guards data or access — and the mutations recorded in
      `scripts/mutations/sets/`.
- [ ] `npm run build`, `npm test`, `npm run typecheck`, `npm run lint` — exit
      codes read directly, not through a pipe.
- [ ] Rules touched? Emulator suite run, and the field in its `…Keys()` list.
- [ ] No secrets and no Firebase config in the diff.
- [ ] Closes an issue? A note in `RELEASE_NOTES.md`, with the PR link once
      the pull request exists.
- [ ] `README.md`, `docs/` and this file re-read against the diff — a claim
      that is now false teaches the next reader to distrust the load-bearing
      ones. If nothing needed changing, say so in the PR.
