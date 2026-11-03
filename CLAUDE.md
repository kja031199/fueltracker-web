# CLAUDE.md

Operating manual for an AI assistant working in this repo. Read it before
changing anything: it is an index of the rules that are load-bearing and the
traps that have already been fallen into.

**Keep it short.** A rule and its reason in a sentence or two; the long version
belongs in the docblock of the module it concerns, where somebody editing that
code will actually read it, or in [`docs/`](docs/). The first version of this
file grew to 360 lines of retold reasoning, which nobody consults.

User-facing documentation is [`README.md`](README.md) and [`docs/`](docs/).
Where they disagree with this file, fix both.

## What this is

A browser rewrite of [FuelTracker](https://github.com/kja031199/FuelTrackingApp),
a frozen iOS + watchOS app that serves as the specification. React 19,
TypeScript 7, Vite, Dexie over IndexedDB, Firebase Auth and Firestore, deployed to Firebase
Hosting at `fueltracker-899eb.web.app`.

- `src/domain/` — pure logic, no storage and no React: statistics, units, the
  draft gate, the palette, the backup reminder, the idle-timeout rule, the scan
  parsers (`scanning/`). **It imports nothing from `data/` or `ui/`**, and
  `src/test/layering.test.ts` enforces that (#54).
- `src/data/` — records and persistence. `store.ts` is the write surface,
  `repository.ts` the storage abstraction, `db.ts` the Dexie binding,
  `sync.ts` the reconciliation, `records.ts` the record types and `Snapshot`,
  `recordValidation.ts` **the one decoder** for a row from anywhere (account,
  JSON backup or CSV), `backupFormat.ts` the file envelopes around it,
  `recordId.ts` which ids can be stored at all,
  `tombstone.ts` what a deletion leaves, `accountStore.ts` the per-account
  database.
- `src/data/firebase/` — the **only** place the Firebase SDK is imported.
- `src/ui/` — React: screens, hooks, hand-drawn SVG charts (`charts/`).

No file or test counts here: the first version carried them and they were wrong
a pull request later. Run `npm test` for the real figure.

## How to work here

**Test first, and show the red.** Write the test, run it, confirm it fails for
the right reason, then implement, then run the whole suite. Put the failing run
in the pull request — "I wrote tests" and "I wrote tests that would have caught
this" are different claims. The one exception is a pure refactor, where the
existing suite passing unchanged *is* the assertion; say so rather than quietly
skipping the step.

**Docs last.** Re-read `README.md`, `docs/` and this file against the diff
before opening the pull request, because only then is it clear what actually
changed. Receipts were bounded at two different sizes for a week while the docs
mentioned one of them — the gap in the docs was the gap in the code.

**Mutation-test anything whose silent failure is expensive.** Break it on
purpose, watch the suite go red, put it back. Required for `firestore.rules`,
account separation, and anything guarding the data boundary: a test that cannot
fail is decoration, and a rules test that cannot fail is worse because it reads
like proof. The recorded results live in [docs/development.md](docs/development.md#mutation-testing).

**Assert the mechanism, not a stopwatch.** `receiptBounds.test.ts` proved "the
bound is checked before `atob`" with a 1000 ms budget; it failed at 2673 ms in a
full run and passed in isolation, because the worker was starved rather than the
payload decoded. It spies on `atob` now, with a second test proving the spy sees
a real decode.

**Check exit codes directly.** `npm run typecheck | tail` reports *tail's*
status. That shipped a broken typecheck to `main` once: redirect to a file and
read `$?`.

**Everything runs here**, unlike the Swift original — Node 22, the full suite,
and the Firestore emulator. There is no excuse for an unverified assertion.
Use the pinned CLI, which is what CI runs:

```bash
npm ci --prefix .github/firebase-cli
.github/firebase-cli/node_modules/.bin/firebase emulators:exec \
  --only firestore --project fueltracker-rules-test \
  "npx vitest run src/data/firebase/rules.test.ts"
```

(`firebase-tools` is the CLI; `firebase` is the SDK and ships no binary.)

## Hard invariants

1. **Every fill-up is built from a `FuelEntryDraft`.** `addFillUp` takes a
   draft, not loose fields, so no function here *could* write an unvalidated
   entry. Rejects non-positive **and** non-finite; `+Infinity` passes `> 0`.
2. **Nothing from the account is trusted.** `syncOnce` puts every pulled
   document through `recordValidation.ts` first. `RemoteStore.pull()` returns
   `RawSnapshot` (`unknown[]`) on purpose — the honest type is what forces the
   validation. Do not "simplify" it to `Snapshot`.
   **The same decoder reads files** (#54): `backupFormat.ts` only unwraps the
   envelope and turns base64 receipts into bytes. Do not add a second row
   parser; there were two, and they drifted into a lockout (#50).
3. **Deletions are tombstones, and a tombstone carries only the sync fields.**
   A hard delete leaves nothing to propagate. `tombstone.ts` owns the shape and
   `Repository.remove` takes the builder as an argument; nothing may spread a
   whole row into a tombstone (#25).
4. **Storage is canonical** — miles, US gallons, US MPG — converted only at the
   display boundary. L/100km is the *reciprocal* of MPG, so charts convert the
   series rather than relabelling the axis.
5. **Local storage is per account**, `fueltracker-u-<uid>`, opened only after
   auth resolves. One shared database once leaked one person's fill-ups into
   another person's Firestore account (`accountStore.ts`). **Nothing that runs
   on sign-in moves data into an account** — sign-in happens before anything
   knows whether the account is allowed. A per-account store holds what that
   account wrote and what its own sync brought down. The pre-accounts rescue
   broke this and was removed (#44); the legacy `fueltracker` database is
   never opened, copied or deleted.
   **So is local state** (#55): every `localStorage` key goes through
   `ui/preferences.ts` and declares a scope. `browser` keys (units, idle
   timeout and its activity marker, the CSP watcher) are about the device;
   `account` keys (backup marker, last sync time, onboarding) are stored as
   `fueltracker.<name>.u.<uid>` and need the uid to read or write.
   `storageBoundary.test.ts` fails if any other module touches web storage.
   A new key: ask whose it is. If it is about a fuel log, it is `account`.
6. **The Firebase SDK is imported only under `src/data/firebase/`.** Everything
   above talks to `AuthProvider` and `RemoteStore`, and no test imports the SDK
   — which is what keeps the suite offline and fast.
7. **The four sync fields are on every record**: client `id`, `updatedAt`,
   `deletedAt`, `schemaVersion`. They cannot be retrofitted over real data.

## Traps

### Rules and deploy

- **`firestore.rules` carries a sign-in allowlist, so adding a *person* is a
  deploy too.** Uids, not emails. `rules.test.ts` parses the list out of the
  rules file rather than copying it, and fails if the list is empty or still
  holds a placeholder. Steps: [docs/accounts.md](docs/accounts.md).
- **`hasOnly` makes adding a field a two-part change**: an unknown field is
  refused, so the rules must deploy *before* a build that writes it. Same pull
  request, and **rules deploy before hosting** in `deploy.yml` for that reason.
- **The deploy toolchain is pinned** in `.github/firebase-cli/` with its own
  lockfile, and `src/test/workflows.test.ts` enforces that plus SHA-pinned
  actions. In *that* directory npm offers `firebase-tools@13.11.2` as the "fix"
  for ten of sixteen advisories — two majors backwards. See
  [docs/deploying.md](docs/deploying.md).
- **gitleaks and lychee are verified against pinned SHA-256s** in `checks.yml`
  (#46): bumping a `*_VERSION` means bumping its `*_SHA256`, taken from the
  release's published checksums and confirmed against your own download, never
  computed in CI. **Every checkout sets `persist-credentials: false`**; both are
  enforced by `workflows.test.ts`.
- **Do not run `npm audit fix`.** Assessed in #19: npm claims a fix for the
  production findings and there isn't one — `firebase` is already current, so
  the suggestion would downgrade it. None of the findings reaches a browser,
  which was checked by grepping the built chunks, not inferred from names.
- **CI has no `.env.local`.** Vite inlines `VITE_*` at build time, so a build
  without them *succeeds* and ships a bundle with no backend. `deploy.yml`
  refuses to deploy if one is missing and greps the served JS for the **app id**
  — not the project id, which is a source constant since #45 and so in every
  bundle, configured or not (`workflows.test.ts` pins this).
- **A development build refuses the production project** (#45):
  `developmentUsesProduction` in `settings.ts` checks `import.meta.env.DEV` *or*
  a local hostname, before Firebase is imported, and renders
  `WrongProjectScreen`. No override, deliberately. Local dev needs its own
  Firebase project, and **uids are per project**, so the dev uid has to be in
  the allowlist too — see [docs/deploying.md](docs/deploying.md).
- **The Firebase web config is public by design** and lives in repository
  Variables. Still never commit it: the API key matches gitleaks'
  Google-API-key rule, and allowlisting a credential pattern is never the fix.
- **`Cross-Origin-Opener-Policy: same-origin` breaks `signInWithPopup`** by
  severing `window.opener`. The value is `same-origin-allow-popups`, and a test
  asserts it is not the dangerous one.
- **The CSP is enforced** (#28), and `csp.test.ts` reads only the enforcing
  header — so reverting to report-only fails the whole file rather than passing
  quietly. `script-src` is `'self'` plus `https://apis.google.com`, which
  Firebase Auth injects to host its auth iframe: the live check refused sign-in
  twice without it. `script-src 'self'` holds for everything else only because
  the built page has no inline script, which the same file enforces.
- **Changing the policy needs the live check**, not reasoning: the deployed
  origin and the auth domain are unreachable from here, and
  signing in needs a real Google account. `cspWatch.ts` collects the evidence
  when armed from the console, and `docs/csp-check.md` is the recipe.
- **The OCR reader is self-hosted** (#17). It lives in `tesseract/<version>/`,
  copied from `node_modules` by the `tesseractAssets` plugin in `vite.config.ts`.
  It is **not precached**, but cached at runtime on first scan. Pass **all
  three** paths to `createWorker`, because a missing one silently falls back to
  jsDelivr. `script-src` needs `'wasm-unsafe-eval'`, and `worker-src` is
  `'self'`. **Its CSP failures happen inside a worker, so `cspWatch` cannot see
  them**: after touching the scanner, the CSP or the service worker, run
  `node scripts/ocr-check/check.mjs`.
- **tesseract.js reads a `Blob`, `File` or canvas, never an `ImageBitmap`.**
  Anything else falls through its loader to `new Uint8Array(image)`, which is
  zero bytes, and the read fails with "pix not read". That is how every real
  scan failed after #63 made the reader load at all. `prepareImage` hands OCR a
  JPEG `Blob`, and `recognise(image: Blob)` refuses anything else. OCR failures
  are `unavailable` (the reader didn't load) or `unreadable` (it loaded, but
  failed on the photo), each with a `detail` shown to the reader. Never fold
  the two together again: that is what sent a scan that loaded fine to
  "check your connection".
- **On a receipt, the `@` fuel line beats a `GALLONS` label** (`fuelLine` in
  `pumpScanParser.ts`). Warehouse-club receipts repeat gallons in a small-print
  summary, and OCR misread it on both runs of a real receipt; corroboration's
  1% tolerance cannot tell 4.092 gallons from 4.099. Don't reorder the trust
  ladder back to labels first, and don't relax `FUEL_LINE`'s three decimals on
  both sides: that is what keeps `2 @ 1.99` from becoming a fuel line.
- **`runtimeCaching` matchers are copied into `sw.js` as source text.** Use a
  RegExp, never a function that closes over a variable in `vite.config.ts`. The
  first tesseract route used `base`, threw inside `sw.js`, never matched, and
  offline scanning failed. `ocrAssets.test.ts` checks the route is a RegExp.

### Data and sync

- **Screens get `FillUpSummary`, not `FillUpRecord`** (#53). `store.fillUps()`
  carries no photo bytes. To edit, load the whole row with `store.fillUp(id)`:
  a form started from a summary saves the fill-up back without its photo. Read
  one vehicle with `listForVehicle` and count with `countLive`; **never
  `list()` + filter** where an index answers it. `list()` is for export and
  sync, which need every row and every photo.

- **`updatedAt` is a logical clock**, `max(wallClock, highestSeen + 1)`, which
  is what makes last-write-wins mean *last edit* rather than *furthest-ahead
  clock*. Adoption is bounded at 30 days, or a row claiming `MAX_SAFE_INTEGER`
  would put the floor where `+ 1` stops producing a larger number. Safe only
  because `updatedAt` is **never displayed** — the date a reader sees is `date`.
- **A refused sync is not an unreachable one.** `SyncResult`'s failure arm
  carries a `kind`: `refused` means the rules refused the *pull* and it will
  never fix itself, `rejected` means they refused an *upload* after the pull
  worked, so the data was refused and not the person (#50), and `unreachable`
  means try again later. Only `refused` closes the app. Detected structurally
  (`cause.code === 'permission-denied'`) because `instanceof FirestoreError`
  would pull the SDK into `sync.ts` and break invariant 6 (#40). A refusal
  **closes the app** (`NoAccessScreen`, #41) rather than being a status line —
  so do not widen `refused` to cover ordinary failures, or the app shuts itself
  every time a phone goes through a tunnel. The refusal `reason` is diagnostic
  now rather than displayed; the screen carries its own copy.
- **Every write carries `syncedAt: serverTimestamp()`, and the rules demand
  it** (`== request.time`, #52). It is what incremental sync reads by, so a
  write without it would never reach other devices. Every *positive* rules test
  must include it (`forWire` does), or the test passes for the wrong reason.
  Records never carry it: `remoteStore.decode` drops it.
- **The sync cursor is exact integer microseconds, per collection, kept in the
  account's IndexedDB** (`syncState.ts`, `DexieSyncState`). Not float ms with a
  margin, which re-downloaded a document on every sync. Not one cursor for all
  three collections, which can skip a write. Not `localStorage`, which can
  outlive the rows. **Elapsed time uses `clock.wall()`**, never the merge
  clock, which jumps ahead.
- **Text limits live in `TEXT_LIMITS` and must equal the rules'** (#50).
  `rulesLimits.test.ts` reads `firestore.rules` to enforce it. Text is bounded
  at the draft gate, in `addVehicle`/`submitFillUp`, and in `importBackup`
  (file *and* pull). A new text field needs a `label()` in the rules, an entry in
  `TEXT_LIMITS`, a place in `recordText.ts`, and a `maxLength` on its input.
  Length is in UTF-16 units, which is what both `.length` and the rules count;
  this was measured, not assumed.
- **A record id is also a Firestore document name, and the legal sets differ.**
  `recordId.ts` is the single rule, applied to the account and to both import
  paths; `sendableRows` keeps an already-stored bad row from aborting the push
  batch, declining to *send* and never to keep (#26).
- **A tombstone is empty, and three things depend on it together**:
  `tombstone.ts` builds it, `preserveLocalReceipts` has an exception for it, and
  `store.scrubTombstones()` cleans up older builds' rows once per store from
  `useAppData`. Keep the scrub idempotent — `isScrubbed` ignores `updatedAt` for
  exactly that reason — and never move `deletedAt`.
- **Receipts have two ceilings, and both drop the photo rather than the row.**
  `MAX_RECEIPT_BYTES` (4 MB) applies on every path that admits a receipt;
  `MAX_SYNCED_RECEIPT_BYTES` (700 KB) is the narrower sync one, because images
  ride inside their document against a 1 MiB cap. An incoming row never
  *removes* a receipt the local copy has.
- **`base64ToBytes` checks its bound before decoding.** Four base64 characters
  carry three bytes, so an oversized payload is refused from the text length
  alone. Deciding after `atob` means the allocation already happened. Carry the
  bound into any new decode path.
- **`backupFormat.ts` stamps CSV-imported rows with the fill-up's own date as
  `updatedAt`**, so imported history loses every merge against the account.
  Known and unfixed; found while fixing #14.
- **Only a JSON export counts as a backup.** CSV is fill-ups only — no
  vehicles, no tombstones, no receipt bytes.
- **A CSV cell is escaped for two readers.** RFC 4180 quoting is for the parser
  and does nothing for the spreadsheet: `"=1+1"` is still evaluated.
  `guardCsvCell` prefixes an apostrophe, the pattern allows leading apostrophes
  so the guard escapes itself, and `unguardCsvCell` removes exactly one. Keep
  the pair reversible, keep it on every cell, keep it after trimming — one test
  defends each (#29).
- **The idle timeout is off by default and deletes nothing.** It gates the
  session, not the data, which stays readable in DevTools; say so in any copy
  about it. Its fallbacks point in opposite directions on purpose: an unreadable
  *period* becomes the default, an unreadable *setting* reads as off.

- **Never filter fill-ups before computing statistics for a date range.** Pass
  the whole history and `{ from }` to `computeFuelStatistics` (#51). An MPG
  segment spans two rows, so filtering first drops the one that crosses into
  the range, and understates distance with it.

### Tests

- **Tests never touch the network or a real device service.**
  `StubAuthProvider` and `InMemoryRemoteStore` exist for this. The iOS original
  paid for the lesson when an `LAContext` call turned every render test into a
  round-trip to a system daemon.
- **Testing Library cannot see vitest's fake timers** — it looks for *Jest*, so
  a blanket `vi.useFakeTimers()` leaves `findBy*`/`waitFor` polling a faked
  `setTimeout` that never fires and the test **hangs** instead of failing. Fake
  only what the code uses, and install fake timers *before* the render.
- **`userEvent.setup()` replaces `navigator.clipboard`**, so stub the clipboard
  *after* calling it or the spy silently records nothing.
- **Component tests opt into a DOM** with a `@vitest-environment jsdom`
  docblock. Domain and storage suites stay on node.

## Checks

Four required on `main`, no bypass actors — **including for you**. Everything
goes through a pull request.

| Check | Fails on |
|---|---|
| Typecheck, test & build | a type error, a hooks lint finding, a failing assertion, a broken build |
| Firestore security rules | the rules letting one account read another |
| Secret scan (gitleaks) | a credential in any commit |
| Docs links (lychee) | a broken relative link or heading anchor |

**The lint is oxlint, hooks rules only** (#57): `react-hooks/rules-of-hooks` and
`react-hooks/exhaustive-deps`, as errors, in `.oxlintrc.json` with every
category switched off — an allowlist, so an oxlint bump cannot add rules and
redden the branch. Not ESLint: `typescript-eslint` needs TypeScript's JavaScript
API, and TypeScript 7 has none (it supports `<6.1`). A finding is fixed, or
disabled on that line with the reason written next to it. It runs as a step in
the "Typecheck, test & build" job. `toolchain.test.ts` pins the config, the
React runtime/types major versions and `vite.config.ts` being type-checked
(it is in `tsconfig`'s `include`, and uses `defineConfig` from
`vitest/config` so its `test` block type-checks).

The build runs **before** the tests, because `manifest.test.ts` and
`csp.test.ts` read `dist/` and would otherwise skip in silence. Merging deploys
automatically and smoke-tests the live site; three workflow runs per merge is
intended ([docs/development.md](docs/development.md)).

## Before opening a pull request

- [ ] The test was written first and seen to fail, and the PR says so.
- [ ] Mutation-tested, if it guards data or access.
- [ ] `npm run build`, `npm test`, `npm run typecheck`, `npm run lint` — exit
      codes read directly, not through a pipe.
- [ ] Rules touched? Emulator suite run, and `hasOnly` remembered.
- [ ] No secrets and no Firebase config in the diff.
- [ ] `README.md`, `docs/` and this file re-read against the diff — a claim
      that is now false teaches the next reader to distrust the load-bearing
      ones. If nothing needed changing, say so in the PR.
