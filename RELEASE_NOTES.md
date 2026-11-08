# Release notes

What changed in FuelTracker, newest first. Every merge to `main` is deployed,
so each date is the day those changes went live (UTC).

Each note starts with what changed **as someone using the app would see it**;
the *Technical* line is for developers, with links to the issue and the pull
request. Every pull request that closes an issue adds its note here — the
"Release notes" check refuses one that does not
([how it works](docs/development.md#release-notes)).

## 2026-11-08

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
