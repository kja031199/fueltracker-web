# Storage, sync and trust

Where the data lives, how two devices reconcile, what a deletion actually
deletes, and why nothing arriving from the account is believed without being
checked first.

## How storage works

Everything lives in the browser, in IndexedDB via [Dexie](https://dexie.org),
**and is synced to a per-user tree in Firestore**. The local copy is the one the
app reads and writes; the account copy is what makes it durable. Browser storage
can be cleared by the reader, by the browser under pressure, or by a privacy
setting — before there was an account, that was total data loss, and the whole
reason export shipped before the charts did.

**Export is still worth doing, and the app now says so.** A backup file is the
only copy that does not depend on somebody else's service staying up, or on you
keeping access to that Google account.

The account is not a backup — it is a second *live* copy, and it replicates a
mistake faithfully. A deletion travels as a tombstone, last-write-wins carries
it to every device, and the free tier has no point-in-time recovery to fall
back on. So a banner asks for a backup when there has never been one, when the
last is over a month old, or after 25 new fill-ups, and **dismissing it snoozes
for a week rather than silencing it** — a permanent dismissal would quietly
re-open the risk it exists to close.

Only the JSON export counts. The CSV is fill-ups only, so treating it as a
backup would tell someone they are protected when a restore would lose their
deletions and their second car.

### Reading only what the screen needs

Every local query used to list a whole table and filter in memory (#53). One
vehicle's fill-ups cost every vehicle's, the fill-up count read every row to
return a number, and both ran after every save, deserialising every receipt
photo each time. Now:

- **One vehicle's rows come from the `vehicleId` index**
  (`listForVehicle`). That index had been declared since the first schema and
  never queried. The fill-up list, the dashboard and removing a vehicle all use
  it.
- **The count reads no rows** (`countLive`). It takes the table's count minus
  the count of a `deletedAt` index (Dexie schema version 3). IndexedDB leaves
  a `null` key out of an index, so that index holds only tombstones.
- **List rows carry no photo bytes.** `store.fillUps()` returns
  `FillUpSummary`: everything but `receiptImageData`, plus `hasReceipt`. The
  screens hold these for the whole session and none of them shows a photo.
  **Editing loads the whole row** (`store.fillUp(id)`), because the form saves
  whatever it starts from, and a summary would save the fill-up back without
  its photo. A distinct type makes that impossible to write by accident.
- **One save means one read** of the selected vehicle's rows. They are re-read
  on a reload counter, not on the identity of the vehicles array.

### Sync reads the device once (#87)

Export and sync need every row and every photo, but they now read each table
**once**. Sync used to read the whole device about seven times per remote — a
snapshot before the merge and another before the push, the merge's own
lookups, the text repair, and for a member one more snapshot per shared car
just to find that car — so a member with three shared cars read the fill-ups
table 34 times per sync. Now:

- **`syncAll` shares one `LocalView`** (`localView.ts`) with every remote. It
  reads every table once, the first time it is needed (a sync that cannot
  reach the account reads nothing), and afterwards only **by id**: the rows a
  merge wrote, the rows a tie re-stamped, the rows the text repair shortened.
  A forgotten car's rows are dropped from it.
- **The merge looks up only the rows it was given** (`getMany`), not every row.
- **The text repair runs once per sync**, in the account's own sync, over every
  row — shared cars' included — instead of once per remote.
- **Single-row questions read single rows:** a duplicate submission,
  "is this car here?", re-stamping a tie and forgetting a shared car go by id
  or by the `vehicleId` index, tombstones included. `listDeleted` reads the
  `deletedAt` index, so it reads no live row at all.

What the view does not see is a write the *app* makes while a sync is
running: that row goes with the next sync, which every save already schedules.
`syncReads.test.ts` counts the reads.

One cost was knowingly left: IndexedDB still deserialises the selected
vehicle's photos once per refresh before they are dropped, because a row
cannot be read without its fields. Moving photos into their own table would
remove that; it would also migrate everyone's local data, so it was deferred.

### How sync works, and why it is so little code

Pull, merge, push — reusing the backup machinery rather than inventing a second
reconciliation:

| Step | What runs |
|---|---|
| Pull | Only what changed since the last sync (see below), then `importBackup`, the same function a restored file goes through |
| Merge | `shouldReplace` — last-write-wins on `updatedAt` |
| Push | `exportSnapshot`, then only the rows newer than the version the account is known to hold |

That reuse was planned from the first commit: every stored row has carried
`id`, `updatedAt`, `deletedAt` and `schemaVersion` since before anything read
three of them, and `backup.ts` already described its merge rule as "the same
rule sync will use."

It buys more than brevity. **Every fill-up arriving from the network goes
through the `FuelEntryDraft` gate**, because that is what `importBackup` does to
anything it writes. Remote data is untrusted input in exactly the way an
imported file is, so a row claiming `NaN` or `+Infinity` gallons is rejected and
counted rather than quietly poisoning every statistic computed from it.

Deletions travel as tombstones and are never hard-deleted: a removed row has to
exist as a fact, or a second device has nothing to learn from and the row simply
reappears on its next push.

### What deleting actually deletes

A tombstone keeps **only what reconciliation needs** — the four sync fields,
plus the vehicle id so a cascade can still be matched. The receipt photograph,
the notes, the station, the coordinates and the measurements are gone, on this
device and in the account.

That is worth stating because it was not always true. Until #25 a tombstone was
written as "the whole row, plus a deletion date", so deleting a fill-up hid it
from the list while keeping its photograph on disk, in the account, and in every
backup taken afterwards. Deleting is the only control anyone has over those
photographs — a receipt shows where somebody physically was — so it needs to do
what it says.

Two consequences worth knowing:

- **A deletion cannot be undone.** There was never an undelete, and now there is
  nothing left to undelete from.
- **Tombstones left behind by older builds are cleaned up on load.** The rewrite
  bumps the row's `updatedAt`, which is what carries the erasure up to the
  account — rewriting the document that still holds the photograph. It runs
  once: a tombstone that is already empty is recognised and left alone.

The row itself stays forever, by design and by necessity: `firestore.rules`
allows no deletes at all, since every write rule is written against the document
being written. Removing a tombstone entirely would need a rules change and is a
separate decision — what this closes is the content living inside it.

### Three ways a sync fails, and they need different sentences

`syncOnce` never throws — being unable to reach the account is the ordinary
condition of an offline-first app, not an error — but there are three failures
behind that, and they ask different things of the reader:

- **Unreachable.** Offline, a flaky connection, the service down. It fixes
  itself and there is nothing to do, so the message says so and the local copy
  carries on working.
- **Refused.** The security rules said no, which arrives as
  `permission-denied`. It will **never** fix itself, and since the allowlist it
  is routine rather than a bug: it is exactly what a signed-in account that is
  not on the list sees. The remedy is specific — send your account id to
  whoever runs this copy — so the message names it. **Only a refused pull
  counts.** An allowed account can always read its own tree.
- **Rejected.** The rules refused an *upload*, after the pull worked (#50). It
  arrives as the same `permission-denied`, but the pull succeeding has already
  proved the account is allowed, so what was refused is the data. The app stays
  open, and the message says the changes are safe on this device.

Both used to read *"Could not reach your account"*, with the real cause in
brackets, which sent the one person who could act on it to check their wifi
(#40). The failure now carries a `kind`, and a refusal is detected
**structurally** — `cause.code === 'permission-denied'` — rather than with
`instanceof FirestoreError`, because importing that would pull the Firebase SDK
into `sync.ts` and the suite would stop running without it.

Telling the last two apart is not cosmetic. Until #50 a refused upload counted
as `refused`, and one station name a character past the rules' limit put an
*allowed* owner on the no-access screen. The batch failed with 0 of 3 documents
uploaded, every retry failed the same way, and the screen hid the fill-up that
would have had to be edited. Reproduced against the emulator before the fix,
and covered there now.

A refusal does more than change the wording: it **closes the app** and shows
the screen described in [accounts.md](accounts.md), because the alternative is
somebody typing into a log that can never sync. An unreachable account changes
nothing — that is the ordinary condition of an offline-first app, and the local
copy keeps working.

### When sync runs, and what one costs

Sync runs on sign-in, **shortly after every save or import**, on window focus
**at most once a minute**, and on demand from Settings (#52;
`src/ui/syncScheduler.ts`). Saves in quick succession share one sync, and a
save made while a sync is running gets another one straight afterwards.

Before #52 a save waited for the next focus. If the browser's storage was
cleared first, the change never reached the account at all, which is the one
loss the account exists to prevent. And every focus was a full read.

There is still no realtime listener. The free tier allows 20,000 writes a day,
which is enormous for one person's fuel log right up until something syncs in a
loop. An app that stops working at 4pm because it burned its quota is a worse
failure than one that is a few seconds stale.

**A sync reads only what changed.** Every sync used to `getDocs` all three
collections, and receipts ride inside fill-up documents (see below). So 100
receipts were 20–50 MB per focus, against a free allowance of 10 GiB of egress
a month. Now:

- **Every upload carries a server stamp**, `syncedAt: serverTimestamp()`, and
  `firestore.rules` refuses a write without one, or with one the client chose
  (`syncedAt == request.time`). Strict on purpose: a write without it would be
  invisible to every incremental read, on every other device, for good.
- **Each collection keeps its own cursor**, the newest stamp it has read, and a
  sync asks for `syncedAt > cursor`. Per collection, because the three
  collections are three reads at three moments. One shared cursor could skip a
  write that landed in one collection between two of the reads.
- **The cursor is exact.** It is stored as integer microseconds, Firestore's
  own precision. The first version kept float milliseconds and re-read a
  millisecond below the cursor to be safe about rounding. Against the emulator,
  that re-downloaded the newest document of every collection on every sync,
  receipt and all.
- **Reads come from the server, never the cache** (`getDocsFromServer`). The
  cursor claims "everything up to here has been seen", and a cached result
  cannot back that claim.
- **What to upload** comes from the versions this device knows the account
  holds (`known`, kept with the cursor), since the whole remote snapshot is no
  longer in hand. Nothing is recorded about a push itself. The next pull
  returns the server's echo of it, and that is when its version becomes known,
  so a half-failed push is never mistaken for one that landed.
- **The merge clock's floor is rebuilt from everything known**, not only from
  what was just pulled (see the next section). Otherwise a reloaded device
  would forget a fast device's timestamps.
- **A full read still happens**: the first time on each device, after a build
  whose `SYNC_CURSOR_VERSION` or `SCHEMA_VERSION` differs, and **weekly** as a
  safety net for anything an incremental read cannot see, such as a document
  deleted in the console. That week is measured on the wall clock, not the merge
  clock. The merge clock jumps ahead after seeing a fast device's rows, so a
  reloaded device thought its last full read was in the future and read in full
  every time. Mutation testing caught that.

**The cursor lives in the account's own IndexedDB database**
(`DexieSyncState`, Dexie schema version 2). It claims "this device holds
everything up to here", which is only true while those rows are on disk.
Anywhere that could outlive them, `localStorage` included, a cleared database
would be followed by a read that never fetches them again.

**Deploying it:** the rules change is in the same pull request and deploys
before hosting, as every rules change does. A copy of the app still running old
code (an installed PWA that hasn't taken its update) has its uploads refused
until it updates. Its changes stay on its device and go up afterwards. Copies
from before #58 report that refusal as no access, so after this deploy, reload
or reopen any installed copy.

### A wrong clock cannot eat your edits

Merges are last-write-wins on `updatedAt`, which was simply `Date.now()` on
whichever device wrote the row. A phone an hour fast therefore beat every edit
made anywhere else: the laptop's correction was overwritten on the next pull,
and the push was then declined because local was no longer greater than remote.
The edit did not conflict, did not warn, and did not come back.

`updatedAt` is now a **logical** clock — `max(wallClock, highestSeen + 1)` — so
a local write is always strictly newer than every row this device has seen.
That is what makes last-write-wins mean *last edit* rather than *furthest-ahead
clock*. It is safe precisely because `updatedAt` is never displayed: the date
you see is the separate `date` field, so inflating the ordering value costs
nothing.

**Two devices in the same millisecond.** The logical clock makes a device's own
writes strictly newer than everything it has *seen* — not than what another
device wrote at the same moment. Two devices can stamp one row with the same
`updatedAt`, and last-write-wins had no answer for a tie: each kept its own
version, neither sent it, and they disagreed for ever. Sharing a car made it
likely (two people, one car), and a shared-car test caught it failing 11 runs
in 12. A tie is now settled by `tieWinner`, identically on every device: a
deletion beats an edit, otherwise the rows' canonical text decides. Where the
account's version wins, the merge takes it; where this device's wins, it is
re-stamped so it is sent and everyone else takes it. `syncTies.test.ts`
reproduces the race deterministically with frozen clocks.

Adoption is bounded at 30 days. A row claiming `Number.MAX_SAFE_INTEGER` would
push the clock to the edge of integer precision, where `+ 1` stops producing a
larger number and every later write ties — and under a `>` comparison a tie
means the newer write loses. Beyond the bound the timestamp is refused, which
means that row keeps winning, so sync says so rather than losing to it quietly.

**The account refuses such a stamp in the first place** (#79). One a year
ahead, written by anyone with access to a shared car, made a fill-up impossible
for anybody else to edit or delete. So `firestore.rules` accepts `updatedAt` at
most 31 days ahead of the server's clock — what a device can adopt plus a day of
slack, pinned to `MAX_ACCEPTED_AHEAD_MS` — and never takes a document's stamp
backwards (the same stamp again is fine: that is a re-send). Every number must
also be finite: Firestore stores `NaN` and the infinities, and `is number`
accepted them.

The no-going-backwards rule has one honest cost. If another device writes a row
between this device's pull and its push, this device's older version is
refused, and with it the batch it was in, so that one sync reports a rejected
upload. The next sync pulls the newer row, takes it, and has nothing older to
send. Before the rule, the older version silently overwrote the newer one.

### Nothing from the account is trusted

Two independent checks, because they fail in different ways.

**On read**, `recordValidation.ts` checks the shape of every document before
anything treats it as a record. The account's contents can predate any rule — a
different build wrote them, a write was interrupted, somebody edited a document
in the console — so a `date` of `"yesterday"`, a `vehicleId` that is an object,
or a 900 KB `station` string used to flow straight into the statistics layer.
The split it applies:

- **Reject the row** when something structural is wrong: a missing `id`, a
  non-finite `updatedAt`, a measurement that is not a number, a fill-up with no
  vehicle. Guessing would invent data.
- **Repair the field** when the problem is cosmetic: text beyond any plausible
  human entry is truncated, an unrecognised fuel grade becomes `Other`, a
  non-boolean full-tank flag becomes `false` (it is truthy in JavaScript, and
  accepting `"no"` as true would silently change the whole MPG chain). Losing a
  fill-up's odometer reading because somebody pasted an essay into its notes
  would be the worse outcome.

Rejections are counted and shown, never silently dropped. The two gates are
distinct and tested separately: shape validation refuses anything **non-finite**,
and the draft gate refuses anything **non-positive**.

**One decoder for every door (#54).** A restored JSON backup and a CSV row go
through exactly these functions too. Only the envelope differs: `backupFormat.ts`
unwraps the file and turns a base64 receipt into bytes, bounded before
decoding. Before this there were two decoders, and they disagreed. The file
path took any length of text, read `isFullTank: "no"` as true, treated a garbled
`deletedAt` as a live row (resurrecting a deletion), kept a 99999 model year,
defaulted a missing `updatedAt` to zero, and silently dropped a submission with
no vehicle. One of those differences was a way into the lockout fixed in #50.
`recordParity.test.ts` sends each of those cases through both doors and requires
the same result.

Two consequences for a hand-edited file: a measurement that is not a number is
refused with its reason, instead of being read as 0, and a row missing
`updatedAt`, `createdAt` or `submittedAt` is refused instead of being defaulted.
Every backup the app has ever written carries all of those fields, so only a
hand edit is affected.

One of those checks is about availability rather than correctness. **A record
id is also a Firestore document name, and the two sets of legal strings are not
the same.** `a/b` makes the SDK throw; `a/b/c` builds a path the rules never
match; `.`, `..` and anything shaped like `__name__` are refused by the
database. Because the push is a single batch and a local row is always newer
than the remote, one such row stopped *every* upload, on every sync, from then
on — and said only "not uploaded yet", which is what being offline says.
Deleting the fill-up did not help, since its tombstone kept the same id. So
`recordId.ts` refuses an unstorable id at every door an id can arrive through,
and sync declines to *send* a row it cannot address rather than handing it to a
batch it would abort. The row stays on the device and is reported: refusing to
upload somebody's data is not a licence to delete it.

**Text had the same failure, and the same shape of fix (#50).** The rules bound
every text field, and nothing on the client did. So the app saved a
201-character station name, and the account refused the whole batch. Now:

- **One table of limits**, `TEXT_LIMITS` in `src/domain/textLimits.ts`, keyed by
  the rules' own field names. `src/data/rulesLimits.test.ts` reads
  `firestore.rules` and fails if the two ever differ. **Change both together,
  rules deployed first.**
- **Bounded at every door:** the draft gate (station, notes), `addVehicle`,
  `submitFillUp`, and `importBackup`, which is the door both a restored file and
  a sync pull come through. The form inputs carry the same numbers as
  `maxLength`, so nobody can type past them.
- **Shortened, never rejected.** This is the policy pulled text already
  followed. Losing an odometer reading over a long note would be worse.
- **Measured in UTF-16 units**, which is JavaScript's `.length`. Measured
  against the emulator, it is also what the rules' `string.size()` counts:
  200 `é` are accepted, and 150 emoji (300 units) are refused. `boundText`
  never leaves half an emoji at the cut.
- **Rows already stored too long are repaired before each push**
  (`repairOversizedText`). Their `updatedAt` moves, so the repair is what
  syncs, and the reader is told how many were shortened.
- **`sendableRows` is the backstop.** It also holds back a row with an
  over-long field or an unstorable `vehicleId` (a CSV only requires that column
  to be non-empty), so if something new slips through, it costs that row and
  not the batch.

**On write**, `firestore.rules` now validates shape as well as identity — field
names, types, string lengths and receipt size. Identity alone stops another
*user* and does nothing about a bad build or a console edit, and the size bounds
are what stop one junk field being inflated to the 1 MiB document cap and eating
the daily quota.

One consequence worth knowing before adding a field: the rules use `hasOnly`, so
an unknown field is refused. **New fields must be deployed to the rules before a
build that writes them** — change both in the same pull request.

The rules suite is 40 assertions against the emulator, including the positive
cases built from records the app itself produces rather than hand-written
literals, which is what stops the rules and the schema drifting apart. It has
been mutation-tested twice: with the shape checks removed 13 assertions fail,
and with the rules wide open 20 do.

### Receipt photos are the exception

Since 3 February 2026 Firebase Cloud Storage requires a linked billing account
even at zero usage, so the natural home for image blobs is off the free tier.
Receipts ride inside their fill-up document as Firestore `Bytes` instead, which
works because `receiptImage.ts` already bounds them at 1600px and quality 0.7 —
usually 200–500 KB, against a 1 MiB document cap.

Usually is not always. A receipt over 700 KB is pushed **without** the image and
reported, so the fill-up syncs and the photo stays on the device that took it.

A second, larger ceiling — 4 MB — bounds what may be *stored* at all, and it
applies on every path that admits a receipt: the draft gate, a restored backup,
and validation of anything pulled from the account. On the import path the bound
is checked **before** the base64 is decoded, since four characters carry three
bytes and the decoded size is known from the text length alone; deciding
afterwards would mean the allocation the guard exists to prevent had already
happened. Oversized or unreadable drops the photo, never the fill-up — the
odometer reading is what the statistics are built on.
Two consequences, both deliberate: a large photo is the one thing a cleared
browser can still lose, and an incoming row never *removes* a receipt the local
copy has — otherwise an edit made on a second device would overwrite the only
remaining copy of the image with null.

### Shared cars sync separately (#66)

A member of a shared car has two places to sync with: their own account, and
that car in its owner's account. `syncAll` (`shareSync.ts`) runs them in turn:

1. **The account's own sync, excluding every shared car.** Without that scope
   the owner's car would be pushed into the member's account — a copy that
   would then diverge for ever.
2. **One sync per shared car**, through `SharingRemote.scoped`: that car's
   fill-ups only, never the car itself. Each has its own cursor in the
   account's database, keyed `share:{owner}__{car}`.
3. **Ended shares are forgotten**: a car in the device's ledger but no longer
   shared, one whose sync is refused, and one the owner deleted are removed
   with `forgetVehicle` — a hard delete with no tombstone.

If the list of shares cannot be read, the account's own sync still runs —
excluding every car in the device's **ledger** — and nothing is forgotten on
the strength of a failed read.

A **new** share — not yet in the ledger — whose car id is already a car on this
device is never synced (#78): it is reported as `clashed`, never recorded in
the ledger, and still kept out of step 1, so it fails closed until it is left.
The rules and Accept refuse such a join first; this guard is for one that got
past both, such as an Accept on a device that had not yet synced the car.

The ledger is what keeps step 1 honest when the list cannot say, so it fails
**closed** (#77):

- **A ledger that cannot be read stops the whole sync** this time, reported as
  a pause to retry. It used to read as "nothing is shared", which with the list
  also unreachable pushed the shared car — someone else's fill-ups, receipts
  and notes — into the member's own account. A readable list is not enough on
  its own: a car left on another device is no longer in it, but is still here.
- **Every current share is written to the ledger before any of its rows are
  pulled**, and an ended share leaves the ledger only after its rows are
  forgotten. So no failure or closed tab can leave shared rows on the device
  that the ledger does not know about. If that first save fails, no share is
  pulled this time. The owner needs none of
this: a member's fill-ups simply appear in the owner's own account.

**A shared car's sync is reported like the account's own** (#84). An upload
the owner's account refuses is `rejected` — about the data, so "will be
retried" would never come true — and the notice says so by car and owner,
where it used to say the car "could not be reached". Only the network is
`failed`. And what each shared car's sync reports — unusable rows, photos too
large to send, rows that cannot be sent — is added to the account's own
counts, where it used to be dropped.

A member's incremental read asks for `vehicleId == car` **and** `syncedAt >
mark`, which needs a composite index (`firestore.indexes.json`). Until it is
deployed — see [deploying.md](deploying.md#the-shared-car-index-is-deployed-by-hand-66)
— the read falls back to the whole car: correct, only less economical.

## Backups, imports and the shape of a row

Two formats, two jobs. The **JSON backup** is the complete one — every vehicle,
every fill-up, receipt bytes, and the deletions too — and importing it **merges
rather than replaces**, matching rows by id and keeping whichever was edited
more recently. So restoring last week's backup cannot destroy this morning's
correction, and importing the same file twice does nothing the second time. The
**CSV** is for spreadsheets: fill-ups only, in canonical miles and US gallons
whatever units you have selected, with the unit named in every column heading —
because a file whose meaning depends on a setting that is not in the file is a
file you will misread a year from now.

A CSV cell is escaped for **two different readers**, and they want different
things. RFC 4180 quoting is what makes the file parse; it does nothing about
what a spreadsheet *executes*. Excel, LibreOffice and Google Sheets all treat a
cell starting with `=`, `+`, `-`, `@`, a tab or a carriage return as a formula,
and quoting does not help — `"=1+1"` is still evaluated. So a cell like that is
written with a leading apostrophe, which spreadsheets read as "this is text"
and do not show. It matters because not all of this text is self-authored: a
station name can come from OCR'd receipt text, from an imported file, or (once
the shareable link lands) from somebody else entirely. The guard escapes itself
and the importer removes exactly one apostrophe again, so an export and a
re-import still agree — an escape that is not reversible would corrupt data,
which is a worse bug than the one it prevents.

Imported fill-ups go through the same validated draft as anything typed in. An
import file is a new input source and an untrusted one — hand-edited, written by
another app, or truncated — so a row with impossible numbers is rejected and
reported rather than written, and one bad row does not cost you the other nine
hundred.

Sync is deferred, not designed away. Every stored row carries four fields from
its very first write, even though three of them are not read yet, because they
cost nothing now and cannot be retrofitted later without migrating real data:

| Field | Why it has to exist from day one |
|---|---|
| `id` | A **client-generated UUID**. A server-assigned id cannot be reconciled with a row created offline. |
| `updatedAt` | Epoch ms, stamped on every write — the basis for last-write-wins. |
| `deletedAt` | A **tombstone, not a row deletion**. A hard delete leaves nothing to propagate, so a row deleted on one device reappears from another. The tombstone keeps only the sync fields — see [what deleting actually deletes](#what-deleting-actually-deletes). |
| `schemaVersion` | Stamped at write time so a future migration knows what shape it is reading. |

`remove` takes the tombstone *builder* rather than building one itself: the
layer is generic over the record type and cannot know which of a row's fields
are content, which is exactly how it came to keep all of them.

The persistence abstraction is four methods — `list`, `get`, `put`, `remove` —
and there are two implementations: one over Dexie, one over a plain `Map`. The
second is not busywork. Both are held to the same contract by the same tests, so
the interface cannot quietly grow a Dexie-shaped hole, and the store's own tests
stay fast and deterministic while a separate integration suite exercises the
real IndexedDB path — including whether receipt bytes survive a structured
clone, which a `Map` could never tell you.

**Every fill-up that reaches storage is built from a validated draft.** That is
inherited from the original architecture and it is enforced by the signature:
`addFillUp` takes a `FuelEntryDraft`, never loose fields, so there is no
function here that *could* write an unvalidated entry. A submission from another
person passes the same gate twice — once on submission and again on approval,
because the record sat in storage in between.
