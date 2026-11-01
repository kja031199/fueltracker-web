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
  the idle-timeout rule, the three scan parsers (`scanning/`), backup
  serialisation.
- `src/data/` — records and persistence. `store.ts` is the write surface,
  `repository.ts` the four-method abstraction, `db.ts` the Dexie binding,
  `sync.ts` the reconciliation, `recordValidation.ts` the shape check on
  anything from the network, `recordId.ts` which ids can be stored at all,
  `tombstone.ts` what a deletion leaves, `accountStore.ts` the per-account
  database.
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
5. **Last, before the pull request: update `CLAUDE.md` and `README.md` if the
   change made anything in them wrong or incomplete.**

Step 5 is not a formality, and it goes last because that is when you know what
actually changed rather than what you intended to change. Ask of each file:
does it now describe only half of this? Receipts were bounded at two different
sizes for a week while both documents mentioned only one of them, which is
precisely how the unbounded import path survived as long as it did — the gap in
the docs was the gap in the code, written down.

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
6; a permanent dismissal instead of a snooze fails 2. For the idle timeout —
resetting the activity marker on mount instead of reading it (i.e. a reload gets
you back in) fails 3; `>` instead of `>=` at the boundary fails 1; passing an
unreadable period straight through instead of defaulting it fails 6; clamping a
future timestamp to "no time has passed" instead of restarting fails 3. Its
first implementation was written deliberately naive, before the real one, and
failed 13 of the pure rule's 34 assertions — all of them hostile-input or
boundary cases. For the tombstone scrub — restoring `{ ...row, deletedAt }`
fails 14; keeping the receipt while emptying everything else fails 7; an
`isScrubbed` that always answers yes (so the cleanup silently does nothing)
fails 7; one that compares `updatedAt` too (the write loop) fails 2; dropping
the tombstone exception in `preserveLocalReceipts` fails 1.

**Assert the mechanism, not a stopwatch.** `receiptBounds.test.ts` checked that
an oversized payload is refused *before* `atob` by giving the refusal a 1000 ms
budget. It failed at 2673 ms in a full run and passed in isolation: nothing had
decoded, the worker was starved by two new jsdom suites. It now spies on `atob`
and requires it was never called, with a second test confirming the spy *does*
see a legitimate decode — a spy on a name the code no longer calls would report
"never decoded" forever and read exactly like a passing bound check.

### Do not run `npm audit fix`, and know why

Not superstition, and not "dependency updates are scary". Assessed in #19 and
recorded in the README: `npm audit` reports a fix as available for the four
production findings, and there isn't one. `firebase` is already at the latest
published version, so the suggested resolution is a major change that would most
plausibly **downgrade** it — leaving the app less current while reporting
success.

The same assessment found that **none of the findings reaches a browser**, which
was checked by grepping the built chunks rather than reasoned from package
names. Re-check that way rather than trusting the severity column; `npm audit
--omit=dev` separates what ships from what builds.

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
3. **Deletions are tombstones, never row deletions — and a tombstone carries
   only the sync fields.** A hard delete leaves nothing to propagate, so the row
   returns from whichever device still has it. But `{ ...row, deletedAt }` kept
   the receipt photograph of a fill-up somebody deleted (#25), so the shape is
   built by `tombstone.ts` and `Repository.remove` takes the builder as an
   argument. Nothing may spread a whole row into a tombstone.
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
- **A record id is also a Firestore document name, and the legal sets differ.**
  `a/b` makes the SDK throw, `a/b/c` builds a path the rules never match, and
  `.`, `..` and `__anything__` are refused by the server. One such row used to
  stop **every** push, on every sync, forever — reported as the ordinary "not
  uploaded yet" — and deleting the fill-up did not help, because the tombstone
  carried the same id. `recordId.ts` is the single rule, applied in
  `recordValidation` (the account) and `backupFormat` (JSON and CSV imports);
  `sendableRows` in `remote.ts` keeps an already-stored bad row from aborting
  the batch. It declines to **send**, never to keep: the row stays local and is
  reported in `SyncOutcome.unsendable`.
  The rules deliberately gained **no** new clause for this — a document name is
  one path segment so it cannot contain a slash, and `data.id == id` already
  refuses a field that disagrees with its own name. There is an emulator test
  asserting that rather than a comment claiming it.
- **A tombstone is empty, and three things depend on that together.** The
  builders are in `tombstone.ts`; `preserveLocalReceipts` has an **exception**
  for tombstones, or a deletion arriving from another device would put the photo
  back on the row that was deleted to lose it; and `store.scrubTombstones()`
  rewrites rows older builds left full, which runs once per store from
  `useAppData`. It must stay idempotent — `isScrubbed` deliberately ignores
  `updatedAt`, because comparing it makes every scrubbed row look dirty and
  turns the cleanup into a write loop with a sync loop behind it. The scrub
  bumps `updatedAt` (that is what erases the remote copy) and never moves
  `deletedAt`, which is a fact.
- **Only a JSON export counts as a backup.** CSV is fill-ups only — no
  vehicles, no tombstones, no receipt bytes.
- **Receipts have two different ceilings, and both drop the photo rather than
  the row.** `MAX_RECEIPT_BYTES` (4 MB) is the storage ceiling and applies on
  *every* path that admits a receipt — the draft gate, a file import, and
  validation of anything pulled from the account. `MAX_SYNCED_RECEIPT_BYTES`
  (700 KB) is the narrower sync ceiling, because Cloud Storage needs a billing
  account and images therefore ride inside their document against a 1 MiB cap.
  A row over the sync ceiling still syncs, without its photo, and says so; an
  incoming row never *removes* a receipt the local copy has.
- **`base64ToBytes` checks its bound before decoding, not after.** Four base64
  characters carry three bytes, so an oversized payload is refused from the text
  length alone and never allocated. Deciding after `atob` means the allocation
  the guard exists to prevent has already happened — a hand-edited backup with a
  400 MB receipt took the suite eight seconds to refuse that way. If you add
  another decode path, carry the bound with it.
- **`backupFormat.ts` stamps CSV-imported rows with the fill-up's own date as
  `updatedAt`**, so imported history loses every merge against anything already
  in the account. Known and unfixed — orthogonal to clock skew, with its own
  blast radius. Found while fixing #14.
- **Testing Library does not see vitest's fake timers.** Its
  `jestFakeTimersAreEnabled()` looks for *Jest*, so under a blanket
  `vi.useFakeTimers()` every `findBy*`/`waitFor` polls with a faked `setTimeout`
  that never fires — the test **hangs to its time limit** rather than failing,
  which reads like an infinite loop in the code under test. Fake only what the
  code needs: `vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval',
  'Date'] })`. Fake timers must also go in **before** the render, or the interval
  the component armed is the real one and advancing does nothing.
- **The idle timeout is off by default, and it signs out without deleting
  anything.** The per-account database is left in place on purpose (see
  invariant 5), so the timeout gates the *session*, not the data — which stays
  readable in DevTools. Say that in any copy about it. Its fallbacks point in
  opposite directions deliberately: an unreadable **period** becomes the default
  (never "no timeout" — an invisible failure), an unreadable **setting** reads as
  off (no evidence of consent). Both are documented at the top of
  `domain/idleTimeout.ts`; keep them that way if you touch either.
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
- [ ] **`README.md` and `CLAUDE.md` re-read against the diff** — the last step,
      because only now is it clear what changed. A claim that is now false, or
      true but no longer complete, is worse than no claim: it teaches the next
      reader to distrust the parts that are load-bearing. If nothing needed
      changing, say so in the PR rather than leaving it ambiguous.
