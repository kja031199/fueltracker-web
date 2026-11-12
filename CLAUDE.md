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
  parsers (`scanning/`). **It imports nothing from `data/` or `ui/`, nor
  React, Dexie or Firebase**, and `src/test/layering.test.ts` enforces that
  (#54, #93), along with `data/` never importing `ui/`. A pure function a
  component needs goes here and is tested here, not inside the component
  (#93): `describeSince`, `vehicleSubtitle` (`format.ts`), `parseTypedNumber`,
  `editableText` (`fillUpForm.ts`). One that reads a record goes beside the
  record mappings (`formFromRecord`, `data/recordMapping.ts`); a sentence
  about a data-layer code goes in `ui/*Messages.ts` (`syncMessages`,
  `linkMessages`).
- `src/data/` — records and persistence. `store.ts` is the write surface,
  `repository.ts` the storage abstraction (and `Repositories`), `db.ts` the
  Dexie schema with its adapters beside it (`dexieRepository.ts`,
  `dexieState.ts`), `sync.ts` the reconciliation, `syncState.ts` its cursor and
  `shareLedger.ts` the shared cars held, `records.ts` the record types and
  `Snapshot`, `recordMapping.ts` draft ↔ record,
  `recordValidation.ts` **the one decoder** for a row from anywhere (account,
  JSON backup or CSV), `backupFormat.ts` the file envelopes around it
  (`parseBackupFile` reads a chosen file by its name),
  `recordId.ts` which ids can be stored at all,
  `tombstone.ts` what a deletion leaves, `accountStore.ts` the per-account
  database. **No import cycles, and the storage modules never import the
  store, sync or sharing modules above them** (#91; `importCycles.test.ts`,
  type-only imports included). Sharing's plain shapes are `sharingTypes.ts`;
  the store's clock type is in `syncClock.ts`.
- `src/data/firebase/` — the **only** place the Firebase SDK is imported
  (`sdkBoundary.test.ts`, #93).
- `src/bootstrap.ts` — **what loads when** (#90), wired by `main.tsx`: a shell
  renders at once, the auth module loads next, and the Firestore modules
  (`remoteStore`, `sharingRemote`, ~140 KB gzipped) only **on sign-in**,
  alongside opening the account's database — so the sign-in screen never waits
  for them. If they fail to load, the log opens locally without sync and the
  next auth event retries. `boot` takes its loaders as arguments
  (`bootstrap.test.ts`), and a test holds `main.tsx` to importing the
  Firestore modules only inside `loadRemotes`. Don't add a static Firebase
  import to `main.tsx` beyond `settings`.
- `src/ui/` — React: screens, hooks, hand-drawn SVG charts (`charts/`).
  `App.tsx` gates on auth and holds per-browser preferences; `fuelLog.tsx`
  (`FuelLogProvider` / `useFuelLog`, `useSyncStatus` for sync status and
  `useBackupStatus` for the backup reminder) owns the data, sync, **every
  write** and every backup, export and file import;
  `AppShell.tsx` is the signed-in app (#56): the tabs come from one
  `TAB_TABLE` in `useTabRoute.ts`, each with a screen in a `Record<Tab, …>`,
  and a visited tab is kept inside React's `<Activity>` (see Rendering). The
  reader's units and the session are contexts in `session.tsx` (`useUnits`,
  `useSession`), not props. Since #93 the fuel
  log's shape is `fuelLogTypes.ts` and its sharing lists `useSharingView.ts`;
  the fill-up form's state and save are `useFillUpForm.ts` (the scan rule,
  `applyScan`, is pure in `domain/fillUpForm.ts`); Settings is one component
  per section in `ui/settings/`; a car's row is `VehicleRow`, with one `mode`.

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

**Every pull request that closes an issue adds a release note.** One entry in
[`RELEASE_NOTES.md`](RELEASE_NOTES.md) under today's `## YYYY-MM-DD` (UTC): a
bold sentence for someone using the app, a `*Technical:*` line, and the issue
link; add the `PR #n` link once the pull request exists. The "Release notes"
check refuses a pull request whose `Closes #N` (or title `(#N)`) has no added
line naming `#N` ([docs/development.md](docs/development.md#release-notes)).

**Mutation-test anything whose silent failure is expensive.** Break it on
purpose, watch the suite go red, put it back. Required for `firestore.rules`,
account separation, and anything guarding the data boundary: a test that cannot
fail is decoration, and a rules test that cannot fail is worse because it reads
like proof. **Record each mutation as data** in `scripts/mutations/sets/` (#98)
— file, exact `from`, `to`, optionally `tests` — never as a hand-counted table
row: `npm run mutate -- <name>` runs it, `npm run mutate` runs all of them
inside one emulator, and the weekly `mutation.yml` fails on a survivor. An
equivalent survivor gets `survives` with the reason. **A refactor that moves
code a mutation targets fails `src/test/mutations.test.ts`** (its text must
occur exactly once): update the mutation's `from`/`to` to the new code rather
than deleting it, and run it to see it still killed. Details in
[docs/development.md](docs/development.md#mutation-testing).

**Assert the mechanism, not a stopwatch.** `receiptBounds.test.ts` proved "the
bound is checked before `atob`" with a 1000 ms budget; it failed at 2673 ms in a
full run and passed in isolation, because the worker was starved rather than the
payload decoded. It spies on `atob` now, with a second test proving the spy sees
a real decode.

**Size and coverage** (#99): the gzipped bundle has a budget per chunk
(`bundleBudget.build.test.ts`) — raise one only with a reason in the PR.
Coverage is printed in the PR check's summary and is never a threshold.
`.github/pull_request_template.md` copies the checklist below; change the
checklist here and the template with it (`guardrails.test.ts`).

**Formatting is Prettier's** (#99): run `npm run format` before committing;
CI fails on `npm run format:check`. Only TS/JS/CSS are formatted — Markdown,
JSON and `firestore.rules` are not. A reformat that moves code a mutation
targets makes `mutations.test.ts` fail: re-anchor the mutation to the
formatted text.

**Check exit codes directly.** `npm run typecheck | tail` reports *tail's*
status. That shipped a broken typecheck to `main` once: redirect to a file and
read `$?`.

**Everything runs here**, unlike the Swift original — Node (the version in
`.nvmrc`), the full suite,
and the Firestore emulator. There is no excuse for an unverified assertion.
Use the pinned CLI, which is what CI runs:

```bash
npm ci --prefix .github/firebase-cli
npm run test:rules   # the *.emulator.test.ts files, inside emulators:exec
npm run test:build   # vite build, then the *.build.test.ts files
npm run mutate:check # every recorded mutation still applies (no tests run)
npm run mutate       # every recorded mutation killed (most of an hour)
```

(`firebase-tools` is the CLI; `firebase` is the SDK and ships no binary.)

## Hard invariants

1. **Every fill-up is built from a `FuelEntryDraft`.** `addFillUp` takes a
   draft, not loose fields, so no function here *could* write an unvalidated
   entry. Rejects non-positive **and** non-finite; `+Infinity` passes `> 0`.
   **The copy between a draft and a record is written once** (#91),
   `recordMapping.ts`: `fillUpFromDraft`, `pendingFromDraft`, and
   `draftFromRecord`, which goes back through the gate. Never spell the fields
   out again in a new write path.
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
   whole row into a tombstone (#25). A fill-up's tombstone also keeps
   `vehicleId` and `enteredBy`, which the rules check on a shared car (#66).
   The one hard delete is `Repository.purge`, for `forgetVehicle` only.
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
   `ui/preferences.ts` and declares a scope. `browser` keys (units, the
   idle-timeout activity marker, the CSP watcher) are about the device;
   `account` keys (backup marker, last sync time, onboarding) are stored as
   `fueltracker.<name>.u.<uid>` and need the uid to read or write.
   `storageBoundary.test.ts` fails if any other module touches web storage.
   A new key: ask whose it is. If it is about a fuel log, it is `account`.
6. **The Firebase SDK is imported only under `src/data/firebase/`.** Everything
   above talks to `AuthProvider` and `RemoteStore`, and no test imports the SDK
   — which is what keeps the suite offline and fast. `sdkBoundary.test.ts`
   checks every production file (#93).
7. **The four sync fields are on every record**: client `id`, `updatedAt`,
   `deletedAt`, `schemaVersion`. They cannot be retrofitted over real data.
8. **Screens write through `useFuelLog()`, never the store** (#56). Every
   write action is built by `written` in `fuelLog.tsx`: store call, then
   refresh, then `afterWrite()` (sync shortly). A throw skips both. Only the
   files in `ALLOWED` in `storeBoundary.test.ts` may import `data/store` —
   `fuelLog.tsx`, `App.tsx` (which just hands it over) and the fuel log's own
   hooks and helpers, each with its reason; the test reads `.ts` as well as
   `.tsx` and fails otherwise, and
   `FuelLog.test.tsx` proves every action reaches the remote. A new write is a
   new action there — not a `store` prop and an `onChanged` callback, which is
   the shape that made "sync after a write" depend on memory.
9. **A shared car stays in its owner's tree** (#66). Members read it and read
   and write **its** fill-ups through the rules; nothing else of the owner's.
   Membership lives in `vehicles/{id}/members`, never in the vehicle record
   (the owner's last-write-wins push would erase it). A member's own sync
   must exclude shared cars and each shared car's sync must push only its
   fill-ups — the `scope` on `syncOnce`; get either wrong and a car is copied
   into the wrong account. An ended share is `forgetVehicle`d: a hard delete,
   **no tombstone**, because those rows were never the member's to delete.
   **The share ledger fails closed** (#77): unreadable means no sync at all,
   never "nothing is shared"; a share is saved to it *before* its rows are
   pulled and leaves it only *after* they are forgotten. Never add a
   `.catch(() => [])` to `ledger.load()`.
   **Revoking holds on the server** (#80): accept is **one batch** (member doc,
   membership, invitation deleted) and the rules refuse a join that leaves the
   invitation (`!existsAfter`); `memberOf` and joining require a live car;
   `removeMember` also withdraws a leftover invitation, looked up rather than
   deleted blind (deleting a missing invitation is refused, and fails the
   batch); deleting a car calls `endSharing`.
   **Never join, sync or record a share whose car id is already yours** (#78):
   the rules refuse the join (`!exists` on your own `vehicles/{id}`), Accept
   checks `store.hasVehicle` first, and `syncAll` reports a new share naming a
   car on the device as `clashed` — not synced, not in the ledger, still
   excluded from the own push. A car id is not secret.

## Traps

The rules and deploy traps, and the data and sync ones, live beside the code
they govern, each tagged with its issue: `git grep -n '@trap'` lists them all.

### Rendering

- **Accessibility structure** (#95; `src/ui/Accessibility.test.tsx`):
  - **A button repeated per row says which row.** `aria-label` starting with
    the visible word (WCAG 2.5.3, label in name): "Edit the fill-up of …"
    (`fillUpName`), "Request a fill-up for Civic"; `ConfirmButton` takes a
    `labelSuffix`. An `aria-label`, not a visually hidden span: a hidden span
    is still page text, so every `getByText('Civic')` in the tests found two.
    In tests, match these names by their start (`/^Share /`), not exactly.
  - **Focus follows the screen.** After a route change `AppShell` focuses the
    page's `h1` (`tabIndex={-1}`, its name ends with the section: "FuelTracker
    — Vehicles"); not on arrival, and compared with the last route rather than
    counted, so StrictMode's double effect is not a change. Opening the
    fill-up form focuses its heading (`focusHeading`), closing it the list's.
    `ScreenFrame`'s `section` also sets `document.title`.
  - **No fixed ids.** Every `id`/`htmlFor`/`aria-*` reference is
    `${idBase}-name` from one `useId()` per component; the test fails on a
    fixed string in any spelling. A heading query that could match the page
    title too (it now names the section) needs `level: 2`.
  - **A list's key is its identity, not its label.** Chart table rows are
    keyed by position: two readings on one day share a label.

- **One copy of each shared pattern** (#93): a page is `ScreenFrame`, a
  confirm-then-act is `ConfirmButton`, a copy is `useCopyToClipboard`, a
  fill-up in a list is `FillUpSummary` (its grey line from `fillUpFacts`), a
  person is `displayName`. `src/test/oneCopy.test.ts` fails on another
  `className="app"`, `navigator.clipboard`, `name || email`, or hand-written
  Keep/Stay button. **The page title is inside `<main>`**, always, so it is
  inside a landmark; banners go in `before` and the tab bar in `after`.
  `ConfirmButton` is controlled — the screen keeps which row is asking, so
  only one asks at a time.
- **Inline `style` is only for a computed value** (#93): a metric's hue, a
  colour that depends on a total. Spacing, lists, rows and quiet text are
  utility classes at the end of `styles.css` (`.stack-sm`, `.after-sm`,
  `.muted`, `.note`, `.list-plain`, `.row-between`, …), and
  `src/test/inlineStyles.test.ts` fails on a style whose values are all
  literals. **Never fade text with `opacity`** — use `.muted`: the text
  colours are palette values (`textPrimary`/`textSecondary` in
  `accessiblePalette.ts`) measured on the card and the page, and a faded
  colour is one nothing measures. The `--text-*` values in `styles.css` are a
  first-paint copy that `accessiblePalette.test.ts` holds to the palette; edit
  the palette, then the copy. A utility that loses to a more specific
  component selector needs a matching selector (`.field input.checkbox`).
- **No interface file over 300 lines** (#93; `src/test/fileSize.test.ts`).
  Past that a component is usually several things: split out a hook for its
  state (`useFillUpForm`), a component per section (`ui/settings/`), a row
  with its own state (`VehicleRow`), and the pure rules into `domain/`. An
  exception is named in the test's `ALLOWED` with the most it may be and the
  change that removes it; the test fails once the exception is no longer
  needed. It is empty now — `App.tsx` was the last, until the route table.
- **A tab keeps its state while another is shown** (#93). `AppShell` mounts
  a tab the first time it is shown and then keeps it inside `<Activity>`:
  hidden, it keeps a half-typed fill-up, its filter, its range; its effects
  are cleaned up until it shows again; it is `display: none`. Two
  consequences. **A hidden tab is still in the DOM**, so in a test a
  `getByText`/`getByLabelText` can find its copy of a label — query by role
  (`getByRole('textbox', { name })`), which skips hidden content as a screen
  reader does. **A hidden tab still re-renders**, at low priority, when the
  fuel log changes; that is the accepted cost. Don't go back to rendering
  only the shown tab: that is what threw the work away.
- **Units and the session are contexts, not props** (`session.tsx`, #93).
  `useUnits()` outside a provider is US with a setter that does nothing, so a
  screen rendered alone in a test needs no wrapper and shows exactly what is
  stored. Settings takes no props; it reads `useSession()`.
- **One display locale, and a currency that follows it** (#94; `format.ts`,
  `useDisplay()` in `session.tsx`). Numbers *and* dates use the browser's
  language (`displayLocale(navigator.language)`, US English when `Intl` has no
  data for it); the currency is `loadCurrency` (Settings → Units and currency,
  else `currencyForLocale`). A `DisplayStyle` `{ locale, currency }` is passed
  to `currency`/`fuelPrice`/`costPerDistance`, its `locale` to
  `volume`/`distance`/`economy`/`formatDate`/`fillUpFacts`/`fillUpName`/
  `describeSince`, and the whole style to the UI phrasers (`kpiText`,
  `insightText`). **Every default is `US_STYLE`, which reproduces the old
  output byte for byte** — the units rule — and `useDisplay()` without a provider is
  `US_STYLE`. Display only: nothing stored changes, and the currency converts
  nothing. A stored currency must pass `isCurrencyCode`, or `Intl` would throw
  on it. **Never `toLocaleDateString()` or a literal `'en-US'` outside
  `format.ts`** (`oneCopy.test.ts`): use `formatDate(ms, locale)` and
  `US_STYLE.locale`. The weekday insight's day names stay English because the
  sentence is English.
- **`domain/` returns numbers; `ui/` writes the words** (#94 part C1). The
  dashboard's KPIs (`dashboardKPIs` → `KPI { id, value, detail }`), the
  weekday insight (`WeekdayInsight`) and chart summaries (`summarizeSeries` →
  `SeriesSummary`) carry no text. Their sentences live in `ui/kpiText.ts`,
  `ui/insightText.ts` and `ui/charts/chartSummary.ts`; the fill-up and
  vehicle phrasing (`fillUpFacts`, `fillUpName`, `describeSince`,
  `displayName`…) in `ui/wording.ts`. Each phraser defaults to US units and `US_STYLE`,
  reproducing the old strings byte for byte, so the old string tests moved
  with them unchanged.
- **`domain/` says nothing in English** (#94 part C2,
  `src/test/domainWords.test.ts`). It names things by identifier (`'liters'`,
  a stored grade, a weekday *number*) and unit symbol (`gal`, `L/100km` —
  symbols, like `€`); every word for those comes from `ui/words.ts`:
  `volumeWords`/`distanceWords` (`name`, `noun`), `economyNames`,
  `gradeLabel`, `rangeLabel` and `weekdayNames`/`weekdayName` (from `Intl`,
  in the display locale). The guard reads every string literal in `domain/`
  — comments and regexes skipped — and refuses a capitalised word or two
  words in a row. Two kinds of word-shaped literal are allowed, by exact
  value, in its `IDENTIFIERS` list: the stored fuel grades (`'Regular'`… are
  Swift's `fuelGradeRaw` and cannot change) and the `'All'` range id. Don't
  grow that list for a label: add the label to `ui/words.ts` instead.
  `domain/scanning/` is exempt — it matches English *printed on* US pumps and
  receipts. `formatDate` of a non-finite time is `—`, not "Invalid Date".
- **Counts go through `countOf(n, { one, other }, locale)`** (#94, `format.ts`):
  `# row was` / `# rows were`, the `#` written in the display locale. The form
  is chosen by **English** plural rules, because the words are English — the
  reader's rules would give "0 row was" in French. Put the whole agreeing
  phrase in each form ("…before it" / "…before them"), not a second ternary.
  No "(s)" and no `=== 1 ? '…'` ternary anywhere (`oneCopy.test.ts`).
  **`DisplayProvider` wraps `FuelLogProvider`** in `App`, so `useSync` can
  read `useDisplay()` and its notes count in the reader's locale ("1.200
  rows"). It reads the locale through a ref so `run`, whose identity the sync
  scheduler is keyed on, never changes with it.
- **The selected car stays in `useAppData`** (#93 asked; kept on purpose).
  It is applied in the same `setShown` as that car's fill-ups (#88); held as
  UI state outside, it would change a render before them and bring back one
  car's name over another's figures.

- **Keep the fuel log's context value stable** (#88). Every screen reads
  `useFuelLog()`, so a value rebuilt each render re-renders all of them: it
  once cost about ten commits per save. `useAppData` and `useSync` return
  memoised objects; `useAppData` reads everything in parallel and applies it
  in **one** `setShown`, dropping a load that finishes after a later one was
  shown. A selection is shown together with its fill-ups, never before them.
  **Sync status is not in `useFuelLog()`**: read it with `useSyncStatus()`.
  `AppShell` must not read it either. `RefusalGate` does, and passes the
  screens through as `children`, so a status change re-renders only the gate.
  A list re-read after every sync (the sharing lists) is replaced only when it
  differs. Number formatting goes through `numberFormat` (`domain/format.ts`),
  which caches one `Intl.NumberFormat` per locale and options.

### Tests

- **Fixtures are shared: `src/test/fixtures.ts`** (#97). `makeStore({ author,
  clock })`, `draft(overrides | odometer)` through the real gate, and
  `sharingFor(world, user | account)`; the emulator suites take
  `allowedUidsInRules` and `rulesEnvironment` from `src/test/emulator.ts`. A file that needs other defaults says so in one line
  — `const draft = draftWith({ date: new Date(2025, 0, 15) })` — rather than
  writing its own: copies drift, and one `makeStore()` had quietly made every
  fill-up "entered by owner". `fixtures.test.ts` fails on a second definition
  or a hand-built empty store. `src/test/` is test support, not app code: the
  SDK boundary skips it.
- **Four test projects, chosen by file name** (#97; `vite.config.ts`,
  guarded by `src/test/projects.test.ts`): `unit` (Node) and `dom` (jsdom:
  every `*.test.tsx` and the `*.dom.test.ts` files), together `npm test`;
  `build` (`*.build.test.ts`, `npm run test:build`, which builds first) and
  `rules` (`*.emulator.test.ts`, `npm run test:rules`). **The project chooses
  the environment** — no `@vitest-environment` docblocks; a `.ts` test that
  needs `document` is named `.dom.test.ts` (in `unit` it fails on the missing
  global, so the mistake shows itself). A file that reads `dist/` or imports
  `test/emulator` must carry the matching name; every test file runs in
  exactly one project. `build` and `rules` **fail** without their
  prerequisite (`needsBuild.ts`, `needsEmulator.ts`) instead of skipping, so
  `npm test` reports no skips and those two cannot pass by skipping. Workflows
  run the npm scripts, never `vitest` with a path: a path is how the rules job
  ran the pure `src/data/firebase/` tests twice. A global setup's error is
  thrown through `prerequisiteError`, whose stack is the message — Vitest 5
  crashed source-mapping a real one and printed the crash instead of the
  reason.
- **Isolation is the config's job** (#97; `src/test/isolation.test.tsx`):
  `restoreMocks`, `unstubGlobals` and `unstubEnvs` put spies, `vi.stubGlobal`
  and `vi.stubEnv` back before every test, and Testing Library unmounts after
  every test on its own (it registers that only because `globals` is on). So
  no `afterEach(cleanup)`, no `vi.restoreAllMocks()` / `unstubAllGlobals()` /
  `unstubAllEnvs()` by hand, and never assign to a prototype — `vi.spyOn` it,
  which is restored; an assignment never was (`importReceipt` leaked a fake
  canvas that way). `projects.test.ts` refuses all four. A spy made in
  `beforeAll` or at module level is restored before the first test: make it
  in `beforeEach` or the test. A mid-test `cleanup()` (re-rendering from
  scratch inside one test) is still fine.

- **A boundary test reads imports through `src/test/imports.ts`, never its own
  pattern** (#93). `layering`, `storeBoundary`, `sdkBoundary` and
  `importCycles` all do. Each used to match `from '…'` its own way, and the
  layering one saw single quotes only, so a double-quoted, side-effect or
  dynamic `import('…')` crossed unseen. `importsOf(file)` returns every
  specifier, resolved to a repo path (`src/data/store`) or left as a package
  name; comments are stripped first, so prose that mentions an import is not
  one. A new rule: write it as a pure function of that list, test it on a
  planted list, then run it over the files.

- **Every file under `src/` is part of the app, or says why not** (#96,
  `src/test/reachable.test.ts`). It walks the imports from `src/main.tsx`,
  dynamic `import()` included, and fails on a production file the walk never
  reaches. A vehicle comparison and an odometer parser were ported, tested and
  refactored twice without ever being shown. To keep one on purpose, add it to
  `KEPT` with the issue it waits on (the odometer parser waits on #143); the
  test also fails once a kept file is wired in or deleted, so the list cannot
  go stale. Test-only helpers live in `src/test/` (`fixtures.ts`,
  `demoData.ts`), not in a production module.

- **The tab is in the URL hash** (`#/dashboard`, `#/fillups`, `#/vehicles`,
  `#/settings`; `useTabRoute.ts`, #56). jsdom keeps one URL per test file, so
  `src/test/setup.ts` resets it after every test — otherwise a test that opens
  Settings starts the next one there. A test that wants a tab passes
  `initialTab` (used only when the hash names none) or sets the hash first.
  **Don't call `new URL()` in app code that tests reach**: `Backup.test.tsx`
  stubs the global `URL` to capture downloads.

- **Tests never touch the network or a real device service.**
  `StubAuthProvider` and the fakes in `src/data/testing/` exist for this:
  `InMemoryRemoteStore` (an account), `InMemorySharingWorld` (accounts and the
  sharing rules between them) and `InMemoryShareLedger`. The iOS original paid
  for the lesson when an `LAContext` call turned every render test into a
  round-trip to a system daemon.
- **A test double lives in a `testing/` folder, never in a production module**
  (#96; `reachable.test.ts`). They used to make `remote.ts` and `sharing.ts`
  twice their size. The only `InMemory*` classes in production code are the
  two production runs: `InMemoryRepository` (a signed-out device) and
  `InMemorySyncState` (`useSync`'s fallback). **A fake reads the way the real
  one does**, or the tests prove a different program: the member's scoped
  pull returns the car's document on every pull and keeps a cursor of that
  car's own (`pullCar`), exactly as `FirestoreScopedRemote.pull` does — it
  once filtered the owner's incremental pull instead, returning the car only
  when it changed. When you change a real remote's reads, change its fake and
  pin the difference in `sharing.test.ts`.
- **Testing Library cannot see vitest's fake timers** — it looks for *Jest*, so
  a blanket `vi.useFakeTimers()` leaves `findBy*`/`waitFor` polling a faked
  `setTimeout` that never fires and the test **hangs** instead of failing. Fake
  only what the code uses, and install fake timers *before* the render.
- **No test waits out the save-sync delay, or sleeps to prove nothing
  happened** (#97). Pass `syncTimers={manualTimers()}` (`src/test/manualTimers.ts`)
  to `App` or `FuelLogProvider`: a write's sync is then `timers.fire()`d when
  the test chooses, and "no sync was scheduled" is `timers.pending() === 0`,
  counted rather than slept past. The rule for the rest: wait for something
  definite — a read counted (`world.reads`, a remote's own counter), a
  `popstate`/`hashchange` event, the last-synced time written, or a positive
  control (one sync on purpose, then exactly that many reads). A sleep passes
  on a slow machine for the wrong reason. `FuelLog.test.tsx` went from 22 s to
  about 1 s this way.
- **`userEvent.setup()` replaces `navigator.clipboard`**, so stub the clipboard
  *after* calling it or the spy silently records nothing.
- **Component tests get a DOM from their project** (`dom`), not a docblock;
  domain and storage suites run on node in `unit`.

## Checks

Four required on `main`, no bypass actors — **including for you**. Everything
goes through a pull request.

| Check | Fails on |
|---|---|
| Typecheck, test & build | a type error, a hooks lint finding, a failing assertion, a broken build |
| Firestore security rules | the rules letting one account read another |
| Secret scan (gitleaks) | a credential in any commit |
| Docs links (lychee) | a broken relative link or heading anchor |

Plus **Release notes** (`release-notes.yml`): a pull request closing an issue
without adding a note for it. Required only once added in branch settings.
Never put `${{ github.event.pull_request.* }}` inside a `run:` — pass it
through `env:` (`workflows.test.ts` enforces it).

**The lint is oxlint, hooks rules only** (#57): `react-hooks/rules-of-hooks` and
`react-hooks/exhaustive-deps`, as errors, in `.oxlintrc.json` with every
category switched off — an allowlist, so an oxlint bump cannot add rules and
redden the branch. Not ESLint: `typescript-eslint` needs TypeScript's JavaScript
API, and TypeScript 7 has none (it supports `<6.1`). A finding is fixed, or
disabled on that line with the reason written next to it. It runs as a step in
the "Typecheck, test & build" job. `toolchain.test.ts` pins the config, the
React runtime/types major versions and `vite.config.ts` being type-checked
(it is in `tsconfig.test.json`'s `include`, and uses `defineConfig` from
`vitest/config` so its `test` block type-checks).

**Two TypeScript projects** (#97), joined by references in `tsconfig.json`
and checked by `tsc -b` (`npm run typecheck`, and the first half of
`npm run build` — `tsc --noEmit` on that root would check nothing):
`tsconfig.app.json` (the app: `types: []`, tests and `src/test/` excluded)
and `tsconfig.test.json` (extends it; the tests, `src/test/` and
`vite.config.ts`, with `vitest/globals`, `jest-dom` and `node`). App code that
names `describe`, `expect` or `process` is a type error now —
`toolchain.test.ts` type-checks a planted file to prove it, with a control
that ordinary DOM code passes. Build info goes to `node_modules/.tmp/`.

`npm run test:build` builds and then runs the `*.build.test.ts` files
(`manifest`, `csp`, `ocrAssets`) against that build, in CI and in the deploy,
whose artifact is that same tested build. Merging deploys
automatically and smoke-tests the live site; three workflow runs per merge is
intended ([docs/development.md](docs/development.md)).

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
