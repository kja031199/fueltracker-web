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

### How sync works, and why it is so little code

Pull, merge, push — reusing the backup machinery rather than inventing a second
reconciliation:

| Step | What runs |
|---|---|
| Pull | `importBackup`, the same function a restored file goes through |
| Merge | `shouldReplace` — last-write-wins on `updatedAt` |
| Push | `exportSnapshot`, then only the rows the account holds an older copy of |

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

Sync runs on sign-in, on window focus, and on demand from Settings. There is no
realtime listener and no sync-per-keystroke — the free tier allows 20,000 writes
a day, which is enormous for one person's fuel log right up until something
syncs in a loop, and an app that stops working at 4pm because it burned its
quota is a worse failure than one that is a few seconds stale.

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

Adoption is bounded at 30 days. A row claiming `Number.MAX_SAFE_INTEGER` would
push the clock to the edge of integer precision, where `+ 1` stops producing a
larger number and every later write ties — and under a `>` comparison a tie
means the newer write loses. Beyond the bound the timestamp is refused, which
means that row keeps winning, so sync says so rather than losing to it quietly.

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

The rules suite is 34 assertions against the emulator, including the positive
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
