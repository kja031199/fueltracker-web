# CLAUDE.md

Operating manual for an AI assistant working in this repo. Claude Code loads it
automatically. Read it before changing anything — it records the things that are
expensive to rediscover, and several of them were learned by getting them wrong.

It overlaps with [`README.md`](README.md), which is written for a reader of the
app. This file is the terse "how to work here" version; where they disagree,
the README is the one users see, so fix both.

## What this is

A browser rewrite of [FuelTracker](https://github.com/kja031199/FuelTrackingApp),
a native iOS + watchOS app that is now frozen and serves as the specification.
Track fill-ups, see fuel economy and spending. React + TypeScript + Vite, Dexie
over IndexedDB, Firebase Auth and Firestore. Deployed to Firebase Hosting at
`fueltracker-899eb.web.app`.

**Pointer map:**

- `src/domain/` — pure logic. No storage, no React, no platform. Statistics,
  units, the draft gate, the accessible palette, the backup-reminder decision,
  the three scan parsers (`scanning/`), backup serialisation.
- `src/data/` — records and persistence. `store.ts` is the write surface,
  `repository.ts` the four-method abstraction, `db.ts` the Dexie binding,
  `sync.ts` the reconciliation, `recordValidation.ts` the shape check on
  anything from the network, `accountStore.ts` the per-account database.
- `src/data/firebase/` — the **only** place the Firebase SDK is imported.
- `src/ui/` — React. Screens, hooks, hand-drawn SVG charts (`charts/`).
- Roughly seventy source files, with a test file beside nearly every one, plus
  a separate suite that runs `firestore.rules` against the emulator.

Exact counts are deliberately not written down here. The first version of this
file carried them and they were wrong one pull request later — a number nobody
recomputes is wrong more often than it is right, and a doc that is confidently
wrong about something checkable is worse than one that is vague about it. Run
`npm test` for the real figure.

## How to work here

### Test-driven, and show the red

The repository owner asked for this explicitly. For any new or changed
behaviour:

1. **Write or update the test first**, expressing the behaviour as it should be.
2. **Run it and watch it fail** — and confirm it fails for the right reason,
   not a typo or a missing import.
3. Implement until it passes.
4. Run the whole suite.

Put the failing run in the pull request. "I wrote tests" and "I wrote tests
that would have caught this" are different claims, and only the second one is
worth anything.

**The one exception**: a pure refactor with no behaviour change gets no new
test — the existing suite passing unchanged *is* the assertion. Say so
explicitly rather than quietly skipping the red step.

### Mutation-test anything whose silent failure is expensive

Not a replacement for the above; an addition. Break the thing on purpose,
confirm the suite goes red, put it back. Required for `firestore.rules`, the
account-separation tests, and anything guarding the data boundary. It has
caught real holes here — a test that cannot fail is decoration, and a rules
test that cannot fail is worse, because it reads like proof.

Recorded results, so a regression is visible: identity-only rules fail 13
assertions; wide-open rules fail 20; one shared database for all accounts fails
6; a permanent dismissal instead of a snooze fails 2.

### Check exit codes directly

`npm run typecheck | tail` reports **tail's** exit status, not tsc's. That
shipped a broken typecheck to `main` once. Redirect to a file and check `$?`.

### Everything runs here, unlike upstream

Node 22, and the full suite executes in this environment — the Swift original
could never run its tests here and everything deferred to CI. There is no
excuse for an unverified assertion in this repo.

The Firestore emulator also runs here: `npx --yes firebase-tools emulators:exec
--only firestore --project fueltracker-rules-test "npx vitest run
src/data/firebase/rules.test.ts"`. Note `firebase-tools`, not `firebase` — the
latter is the SDK and ships no binary.

## Hard invariants

1. **Every fill-up is built from a `FuelEntryDraft`.** `addFillUp` takes a
   draft, not loose fields, so no function here *could* write an unvalidated
   entry. Imports, sync and approvals all go through it. Rejects non-positive
   **and** non-finite — `+Infinity` passes `> 0`.
2. **Nothing from the account is trusted.** `syncOnce` runs every pulled
   document through `recordValidation.ts` before anything treats it as a
   record. `RemoteStore.pull()` returns `RawSnapshot` (`unknown[]`) on purpose:
   the honest type is what forces the validation. Do not "simplify" it to
   `BackupSnapshot`.
3. **Deletions are tombstones, never row deletions.** A hard delete leaves
   nothing to propagate, so the row returns from whichever device still has it.
4. **Storage is canonical** — miles, US gallons, US MPG — with conversion only
   at the display boundary. L/100km is the *reciprocal* of MPG, so charts
   **convert the series**, never relabel the axis.
5. **Local storage is per account.** The database is named `fueltracker-u-<uid>`
   and opened only after auth resolves. One shared database leaked one person's
   fill-ups into another person's Firestore account; see `accountStore.ts`.
6. **The Firebase SDK is imported only under `src/data/firebase/`.** Everything
   above talks to `AuthProvider` and `RemoteStore`. No test imports the SDK,
   which is what keeps the suite offline and fast.
7. **The four sync fields are on every record**: client-generated `id`,
   `updatedAt`, `deletedAt`, `schemaVersion`. They cannot be retrofitted over
   real data.

## Gotchas worth remembering

- **`hasOnly` in `firestore.rules` means adding a field is a two-part change.**
  An unknown field is refused, so the rules must be deployed *before* a build
  that writes it. Change both in the same pull request. This is the cost of the
  protection that stops a junk field being inflated to the 1 MiB cap.
- **Rules deploy before hosting**, in separate steps, for the same reason. One
  `firebase deploy` makes no promise about ordering; `deploy.yml` does.
- **`Cross-Origin-Opener-Policy: same-origin` breaks `signInWithPopup`.** It
  severs `window.opener`. The value is `same-origin-allow-popups` and there is
  a test asserting it is not the dangerous one.
- **The CSP is report-only** until the live flows have been checked with a
  console open. `script-src 'self'` works only because the built page has no
  inline script, which `csp.test.ts` now enforces — it would otherwise break in
  production and nowhere else.
- **OCR fetches from `cdn.jsdelivr.net` at scan time.** `createWorker('eng')`
  takes no paths, so the domain appears nowhere in this repository's source. It
  must stay in `connect-src`.
- **CI has no `.env.local`.** Vite inlines `VITE_*` at build time, so a build
  without them *succeeds* and produces a bundle with no backend. `deploy.yml`
  refuses to deploy if any is missing, and a smoke test greps the served
  JavaScript for the project id.
- **The Firebase web config is public by design** and lives in repository
  Variables, not Secrets. Do not commit it: the API key matches gitleaks'
  Google-API-key pattern, and allowlisting a credential pattern is never the
  fix here.
- **`updatedAt` is a logical clock, not a wall clock.** `max(wallClock,
  highestSeen + 1)`, so a local write is always strictly newer than every row
  this device has seen — which is what makes last-write-wins mean *last edit*
  rather than *furthest-ahead clock*. Adoption is bounded at 30 days, because a
  row claiming `MAX_SAFE_INTEGER` would put the floor at the edge of integer
  precision where `+ 1` stops producing a larger number and every later write
  ties. Past the bound the row keeps winning, and sync reports it.
  This is safe only because **`updatedAt` is never displayed**: it is a
  merge-ordering value, and the date a reader sees is the separate `date`
  field. Do not start showing it.
- **Only a JSON export counts as a backup.** CSV is fill-ups only — no
  vehicles, no tombstones, no receipt bytes.
- **Receipts over 700 KB do not sync.** Cloud Storage needs a billing account,
  so images ride inside their document against a 1 MiB cap. The row syncs
  without the photo and says so, and an incoming row never *removes* a receipt
  the local copy has.
- **`backupFormat.ts` stamps CSV-imported rows with the fill-up's own date as
  `updatedAt`**, so imported history loses every merge against anything already
  in the account. Known and unfixed — orthogonal to clock skew, with its own
  blast radius. Found while fixing #14.
- **Tests never touch the network or a real device service.** `StubAuthProvider`
  and `InMemoryRemoteStore` exist for this. The iOS original paid for this
  lesson when an `LAContext` call turned every render test into a round-trip to
  a system daemon.
- **Component tests opt into a DOM** with a `@vitest-environment jsdom`
  docblock. Domain and storage suites stay on node, which is faster and needs
  nothing a browser provides.

## Checks

Four required on `main`, no bypass actors — **including for you**. Everything
goes through a pull request.

| Check | Fails on |
|---|---|
| Typecheck, test & build | a type error, a failing assertion, a broken build |
| Firestore security rules | the rules letting one account read another |
| Secret scan (gitleaks) | a credential in any commit |
| Docs links (lychee) | a broken relative link or heading anchor |

The build runs **before** the tests, because `manifest.test.ts` and
`csp.test.ts` read `dist/` and would otherwise skip in silence.

Merging to `main` deploys automatically and verifies the live site. Three
workflow runs fire per merge; that is intended — see the README.

## Before opening a pull request

- [ ] The test was written first and seen to fail, and the PR says so.
- [ ] Mutation-tested, if the thing guards data or access.
- [ ] `npm test`, `npm run typecheck`, `npm run build` — exit codes read
      directly, not through a pipe.
- [ ] Rules touched? Run the emulator suite, and remember `hasOnly`.
- [ ] No secrets, and no Firebase config, in the diff.
- [ ] The README updated if a claim in it is now false. A stale promise about
      where data lives is worse than no promise.
