# Release notes

What changed in FuelTracker, newest first. Every merge to `main` is deployed,
so each date is the day those changes went live (UTC).

Each note starts with what changed **as someone using the app would see it**;
the *Technical* line is for developers, with links to the issue and the pull
request. Every pull request that closes an issue adds its note here — the
"Release notes" check refuses one that does not
([how it works](docs/development.md#release-notes)).

## 2026-11-10

- **No change you'll see: the tests are split into three groups, each run on
  purpose.** The third step of tidying the tests.
  *Technical:* Vitest projects chosen by file name — `unit` (`npm test`),
  `build` (`*.build.test.ts`, `npm run test:build`, which builds first) and
  `rules` (`*.emulator.test.ts`, `npm run test:rules` on the emulator). A
  normal run no longer reports 84 skipped tests; `csp`, `manifest` and
  `ocrAssets` now behave alike and never read a stale build; the rules job no
  longer re-runs 44 pure tests. `build` and `rules` fail with a reason rather
  than skip without their prerequisite. `projects.test.ts` holds every file to
  one project and the workflows to the scripts.
  [#97](https://github.com/kja031199/fueltracker-web/issues/97) · [PR #133](https://github.com/kja031199/fueltracker-web/pull/133)
- **No change you'll see: the tests share one set of fixtures instead of
  copying them into every file.** The second step of tidying the tests.
  *Technical:* `src/test/fixtures.ts` (`makeStore`, `draft`/`draftWith`,
  `sharingFor`) and `src/test/emulator.ts` replace 18 `makeStore`s, 16
  `draft`s, 5 `sharingFor`s and 3 copies of the emulator setup; 42 test
  files, about 750 lines of copies gone. `fixtures.test.ts` refuses a second
  definition.
  [#97](https://github.com/kja031199/fueltracker-web/issues/97) · [PR #132](https://github.com/kja031199/fueltracker-web/pull/132)
- **No change you'll see: the test suite runs in about two-thirds of the
  time, and no longer waits on the clock.** The first step of tidying the
  tests.
  *Technical:* `FuelLogProvider` and `App` take `syncTimers` (the scheduler's
  existing seam); tests fire a save's sync with `manualTimers()` and count
  `pending()` instead of sleeping. `FuelLog.test.tsx` 22.5 s → 1.3 s; the
  other fixed sleeps wait on a counted read, a history event or a positive
  control; the receipt-bound test builds 8 MB, not 400.
  [#97](https://github.com/kja031199/fueltracker-web/issues/97) · [PR #131](https://github.com/kja031199/fueltracker-web/pull/131)
- **Easier with a screen reader or a keyboard: each Edit, Delete, Share and
  Request button now says which fill-up or car it is for, and choosing a tab
  or opening the fill-up form moves focus to where you landed.** The browser
  tab's title names the section too.
  *Technical:* row buttons get `aria-label`s that start with their visible
  word (`fillUpName`, `ConfirmButton`'s `labelSuffix`); `AppShell` focuses
  the page title after a route change and `ScreenFrame` sets
  `document.title`; every id comes from `useId`; chart tables are keyed by
  position, so two readings on one day no longer share a key.
  [#95](https://github.com/kja031199/fueltracker-web/issues/95) · [PR #130](https://github.com/kja031199/fueltracker-web/pull/130)
- **Switching tabs no longer loses what you were doing: a half-typed fill-up,
  the fill-ups filter and the dashboard's range are all still there when you
  come back.**
  *Technical:* a visited tab is kept in React's `<Activity>` instead of being
  unmounted; the tabs are one `TAB_TABLE` with a `Record<Tab, …>` of screens
  in the new `AppShell.tsx`; units and the session are contexts
  (`useUnits`, `useSession`) instead of props; the selected car stays in
  `useAppData`, documented. The last part of tidying the interface code.
  [#93](https://github.com/kja031199/fueltracker-web/issues/93) · [PR #129](https://github.com/kja031199/fueltracker-web/pull/129)

## 2026-11-09

- **No change you'll see, except that a car's Share and Request panels no
  longer open at the same time — opening one closes the other.**
  *Technical:* the fill-up form, the fuel log and Settings are split (474,
  473 and 314 lines to 263, 219 and 44): `useFillUpForm` with
  `ReceiptScanField` and `DecimalField`, the scan rule as a pure `applyScan`;
  `fuelLogTypes.ts` and `useSharingView.ts`; `ui/settings/` with one component
  per section. Vehicles gets `AddVehicleForm` and a `VehicleRow` with one
  `mode` instead of four ids. `fileSize.test.ts` holds interface files to 300
  lines, `App.tsx` excepted until the route table.
  [#93](https://github.com/kja031199/fueltracker-web/issues/93) · [PR #128](https://github.com/kja031199/fueltracker-web/pull/128)
- **Grey text is a shade darker, so it is easier to read on the page
  background in light mode; the small print that was faded out is now the
  same measured grey.**
  *Technical:* `textPrimary`/`textSecondary` join the palette and are
  measured on the card and the page (light secondary #6C6C70, 4.69:1 on the
  page, becomes #6B6B6F, 4.76:1); `opacity` on text is gone; 92 of 94 inline
  styles become utility classes, and `inlineStyles.test.ts` refuses a fixed
  one.
  [#93](https://github.com/kja031199/fueltracker-web/issues/93) · [PR #127](https://github.com/kja031199/fueltracker-web/pull/127)
- **Every screen's title now lines up with its content, the way the main app's
  always has, and someone sharing a car who gave only spaces for a name shows
  their email instead of a blank.**
  *Technical:* one `ScreenFrame` (the title inside `<main>` on every page, ten
  frames before), `ConfirmButton` (three pairs), `useCopyToClipboard` (two),
  `FillUpSummary` with `fillUpFacts` (two), and `displayName` (four);
  `oneCopy.test.ts` refuses another copy of each.
  [#93](https://github.com/kja031199/fueltracker-web/issues/93) · [PR #126](https://github.com/kja031199/fueltracker-web/pull/126)
- **No change you'll see: what a fill-up cost, and a price per litre, are now
  worked out in one place.** A link's error message and the "last synced"
  time read as before; a time that is not a number now reads "not yet"
  rather than "Invalid Date".
  *Technical:* one `totalCost` (`recordTotalCost` and `draftTotalCost` gone,
  five inline copies replaced, a test refusing another);
  `pricePerUnit`/`pricePerGallonFrom` for the five per-unit conversions;
  `describeSince`, `vehicleSubtitle`, `parseTypedNumber`, `editableText` and
  `formFromRecord` out of components and tested where they live;
  `linkMessages.ts` and `LinkScreen.tsx` out of `SubmitScreen.tsx`.
  [#93](https://github.com/kja031199/fueltracker-web/issues/93) · [PR #125](https://github.com/kja031199/fueltracker-web/pull/125)
- **Saving a copy from the "no access" screen now counts as a backup**, so
  the reminder stops telling you that you have never saved one.
  *Technical:* the fuel log owns the backup reminder: `saveBackup()` records
  it whichever screen asks, and screens read it through `useBackupStatus()`.
  `exportCsv()` and `importFile()` move out of Settings into the log, and
  `parseBackupFile` reads a chosen file without the `as never[]` cast.
  [#93](https://github.com/kja031199/fueltracker-web/issues/93) · [PR #124](https://github.com/kja031199/fueltracker-web/pull/124)

## 2026-11-08

- **No change you'll see: the tests that keep the app's layers apart now see
  every way one file can load another.** The first step of tidying the
  interface code.
  *Technical:* one import reader (`src/test/imports.ts`) for the layering,
  store, SDK and cycle tests: double quotes, side-effect and dynamic imports
  included. `domain/` may not import React, Dexie or Firebase; `data/` may not
  import `ui/`; the store check covers `.ts` hooks with a reason per allowed
  file; a new test keeps the Firebase SDK in `src/data/firebase/`.
  [#93](https://github.com/kja031199/fueltracker-web/issues/93) · [PR #123](https://github.com/kja031199/fueltracker-web/pull/123)
- **Each sync saves less on your device.** After this update, the first sync
  reads your account in full once; from then on a sync records only what
  changed, instead of rewriting its record of every row each time.
  *Technical:* the known versions leave the sync cursor for their own Dexie
  table (`knownVersions`, schema version 4), written per sync by
  `saveKnown({ replace, set })`; `SYNC_CURSOR_VERSION` 2. The last part of
  tidying the data layer.
  [#91](https://github.com/kja031199/fueltracker-web/issues/91) · [PR #122](https://github.com/kja031199/fueltracker-web/pull/122)
- **No change you'll see: what a failed sync says is now worded by the screens,
  not the data layer.** The sixth step of tidying it.
  *Technical:* sync reports a `problem` code and the cause's `detail`;
  `ui/syncMessages.ts` holds the sentences. `receiptImage.ts` and
  `photoMetadata.ts` move to `ui/`, and a test keeps browser APIs out of
  `src/data`.
  [#91](https://github.com/kja031199/fueltracker-web/issues/91) · [PR #121](https://github.com/kja031199/fueltracker-web/pull/121)
- **No change you'll see: the checks every reader of untrusted data makes, and
  the way both connections to the account read and write, are written once.**
  The fifth step of tidying the data layer.
  *Technical:* `guards.ts` replaces five modules' copies of `finite`, `text`,
  `isRaw` and `asRecord`; `writeStamped`/`readStamped` replace the two
  remotes' copied loops. A history longer than one 500-write batch is now
  tested end to end.
  [#91](https://github.com/kja031199/fueltracker-web/issues/91) · [PR #120](https://github.com/kja031199/fueltracker-web/pull/120)
- **No change you'll see: what the screens can do to stored data and what
  only sync may do are now separate.** The fourth step of tidying the data
  layer.
  *Technical:* `Replica` (`replica.ts`) holds sync's operations; the store
  builds it over its own repositories and clock and has none of them itself.
  [#91](https://github.com/kja031199/fueltracker-web/issues/91) · [PR #119](https://github.com/kja031199/fueltracker-web/pull/119)
- **No change you'll see: sync can no longer be wired to the wrong clock.**
  The third step of tidying the data layer.
  *Technical:* sync takes its clock from the store (always a
  `MonotonicClock`), and its cursor state is a required argument; the
  non-monotonic `systemClock` default is gone.
  [#91](https://github.com/kja031199/fueltracker-web/issues/91) · [PR #118](https://github.com/kja031199/fueltracker-web/pull/118)
- **No change you'll see: the data layer's modules now depend in one
  direction.** The second step of tidying it.
  *Technical:* `Repositories` → `repository.ts`, the store clock →
  `syncClock.ts`, sharing's shapes → `sharingTypes.ts`, the share ledger →
  `shareLedger.ts`, and `db.ts` split into the schema, `dexieRepository.ts`
  and `dexieState.ts`; a test refuses any import cycle in `src/data`.
  [#91](https://github.com/kja031199/fueltracker-web/issues/91) · [PR #117](https://github.com/kja031199/fueltracker-web/pull/117)
- **No change you'll see: how a fill-up is copied into storage is now written
  once.** The first step of tidying the app's data layer.
  *Technical:* `recordMapping.ts` (`fillUpFromDraft`, `pendingFromDraft`,
  `draftFromRecord`) replaces five hand-written copies in the store and the
  import, with a round-trip test.
  [#91](https://github.com/kja031199/fueltracker-web/issues/91) · [PR #116](https://github.com/kja031199/fueltracker-web/pull/116)
- **No change you'll see: the account's security rules are easier to keep
  right.** Every limit they enforce is now checked against the app's own by
  the tests, and each kind of document's fields are written down once.
  *Technical:* `…Keys()` lists and one `shape()` helper in `firestore.rules`;
  every size bound through `label()`/`sized()`/`maxReceiptBytes()`, held to
  the client's constants; one `get()` instead of `exists()` then `get()`; no
  rule for `users/{uid}` itself.
  [#92](https://github.com/kja031199/fueltracker-web/issues/92) · [PR #115](https://github.com/kja031199/fueltracker-web/pull/115)
- **Syncing uses fewer of your account's free reads when you share cars.** Each
  sync now checks which cars are shared with you once instead of twice, and the
  fill-up list stops asking who a car is shared with after it has asked once.
  If shared cars are being read in full because the database is still building
  an index, Settings now says so.
  *Technical:* `syncAll` hands back the memberships it read; "entered by"
  names cached per car (`namesFor`); invitations queried per car; a shared
  car's document and fill-ups read in parallel; `indexMissing` reported;
  screens reload only when a shared car's sync wrote rows.
  [#89](https://github.com/kja031199/fueltracker-web/issues/89) · [PR #114](https://github.com/kja031199/fueltracker-web/pull/114)
- **Release notes.** No change in the app: this file now records what each
  update changed, starting from the fill-up links.
  *Technical:* `RELEASE_NOTES.md`, and a "Release notes" check that fails a
  pull request closing an issue without adding a note for it.
  [PR #113](https://github.com/kja031199/fueltracker-web/pull/113)

## 2026-11-07

- **Saving is lighter on the app.** A save now redraws each screen once instead
  of about ten times, a sync that brings nothing new redraws nothing, and the
  dashboard never briefly shows one car's name with another car's figures.
  *Technical:* `useAppData` loads everything in one update and drops stale
  loads; sync status moved to its own context (`useSyncStatus`); number
  formatters are cached.
  [#88](https://github.com/kja031199/fueltracker-web/issues/88) · [PR #112](https://github.com/kja031199/fueltracker-web/pull/112)
- **Long names no longer break sharing, and backups from a newer version are
  handled safely.** A Google display name over 200 characters used to make
  sending or accepting an invitation fail with no explanation; it is now
  shortened to fit. Restoring a backup made by a newer version of the app skips
  the rows it cannot read, and says how many, instead of importing them
  incompletely.
  *Technical:* sharing text bounded on write and read; newer-schema rows set
  aside before validation; membership ids checked with `isStorableId`;
  validation builds tombstones with `tombstone.ts`.
  [#86](https://github.com/kja031199/fueltracker-web/issues/86) · [PR #111](https://github.com/kja031199/fueltracker-web/pull/111)
- **An edit made during a sync is never lost, and deleting a car is all or
  nothing.** A fill-up saved while a sync was running could be overwritten by
  an older copy and never uploaded; a car deleted as the tab closed could be
  left with some of its fill-ups gone. Deleting a car now also deletes the
  submissions waiting for it.
  *Technical:* merges and cascades run in one IndexedDB transaction and decide
  against rows read inside it; `Repository.putMany`.
  [#85](https://github.com/kja031199/fueltracker-web/issues/85) · [PR #110](https://github.com/kja031199/fueltracker-web/pull/110)
- **Sync messages for shared cars tell the truth.** When a car's owner's
  account refuses your changes, the app now says so, naming the car and the
  owner, instead of saying the account could not be reached. Problems on a
  shared car (an oversized photo, an unusable row) are reported like your own.
  *Technical:* `syncAll` reports `rejected` separately from `failed`, and every
  shared car's outcome counts toward the notice.
  [#84](https://github.com/kja031199/fueltracker-web/issues/84) · [PR #109](https://github.com/kja031199/fueltracker-web/pull/109)
- **Ending a share really ends it.** Removing someone from a car, or deleting
  the car, now stops their access on the server: an invitation can be used
  only once, and a deleted car cannot be read or joined.
  *Technical:* the rules require the invitation to be deleted in the same batch
  as the join and a live car for every member request; deleting a car ends its
  sharing.
  [#80](https://github.com/kja031199/fueltracker-web/issues/80) · [PR #108](https://github.com/kja031199/fueltracker-web/pull/108)
- **A device with a wrong clock can no longer lock a fill-up.** Rows dated far
  in the future, or moving backwards in time, are refused by your account, so
  edits made on other devices keep winning.
  *Technical:* the rules bound `updatedAt` to at most 31 days ahead, never
  backwards, and require every number to be finite.
  [#79](https://github.com/kja031199/fueltracker-web/issues/79) · [PR #107](https://github.com/kja031199/fueltracker-web/pull/107)
- **Syncing reads your device once instead of many times.** Noticeably less
  work per sync, most of all for someone with several shared cars.
  *Technical:* one `LocalView` per sync, reads by id afterwards; the merge
  looks up only the rows it was given.
  [#87](https://github.com/kja031199/fueltracker-web/issues/87) · [PR #106](https://github.com/kja031199/fueltracker-web/pull/106)
- **Editing a fill-up never moves it to another car or brings back a deleted
  one.** If the fill-up or its car was deleted while you were editing, the save
  is refused and the form says so, keeping what you typed.
  *Technical:* `updateFillUp` takes no car and throws `StaleEdit`.
  [#83](https://github.com/kja031199/fueltracker-web/issues/83) · [PR #105](https://github.com/kja031199/fueltracker-web/pull/105)
- **A share that names a car you already have is refused.** Accepting it could
  have handed your car to someone else; the app now explains and leaves it alone.
  *Technical:* the rules refuse the join, Accept checks first, and `syncAll`
  reports the share as `clashed`.
  [#78](https://github.com/kja031199/fueltracker-web/issues/78) · [PR #104](https://github.com/kja031199/fueltracker-web/pull/104)
- **A shared car is never copied into your own account.** If the device cannot
  read its list of shared cars, sync now pauses and says so rather than
  treating every car as yours.
  *Technical:* the share ledger fails closed, and a share is recorded before
  its rows are pulled.
  [#77](https://github.com/kja031199/fueltracker-web/issues/77) · [PR #103](https://github.com/kja031199/fueltracker-web/pull/103)
- **No change you'll see: the deploy is safer.** The key that publishes the
  app is no longer present while its build tools run.
  *Technical:* the deploy is split into a build job and a key-holding deploy
  job in the `production` environment, which runs no npm lifecycle scripts.
  [#76](https://github.com/kja031199/fueltracker-web/issues/76) · [PR #102](https://github.com/kja031199/fueltracker-web/pull/102)

## 2026-11-05

- **The app describes itself correctly when installed.** Its description now
  says your log is kept on your device and synced to your own Google account,
  instead of saying there is no account.
  *Technical:* the manifest and page descriptions, pinned by
  `toolchain.test.ts`; the mutation table in `docs/development.md` repaired.
  [PR #75](https://github.com/kja031199/fueltracker-web/pull/75)

## 2026-11-04

- **Ask someone to log a fill-up for you, by link.** Send a link for one of
  your cars; whoever opens it fills in a fill-up, which waits for you to
  approve or reject it.
  *Technical:* links carry the submission in the URL fragment, decoded as
  untrusted input; received submissions are idempotent by id.
  [#3](https://github.com/kja031199/fueltracker-web/issues/3) · [PR #74](https://github.com/kja031199/fueltracker-web/pull/74)
