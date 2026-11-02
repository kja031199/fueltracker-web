# FuelTracker Web

[![CI](https://github.com/kja031199/fueltracker-web/actions/workflows/ci.yml/badge.svg)](https://github.com/kja031199/fueltracker-web/actions/workflows/ci.yml)

Track gas fill-ups and fuel economy in your browser. **Sign in with Google; your fuel log is stored on your device and synced to your own account.** No analytics, no third party, and nobody but you can read it.

> **Status: complete, now with an account.** Add vehicles, log and edit fill-ups,
> search and filter them, see your economy, spending and price trends as KPIs and
> charts, **export a backup you can restore**, **install it and use it with no
> network at all**, **photograph a receipt** to fill the form in, and **sign in
> with Google so your log survives a cleared browser and follows you to your
> phone**. 650 tests, plus eight that run the security rules against the Firestore
> emulator. What is *not* here was left out on purpose, not left unfinished — see
> [What was deliberately not built](#what-was-deliberately-not-built).

## What this is

A web rewrite of [FuelTracker](https://github.com/kja031199/FuelTrackingApp), a native iOS + watchOS app by the same author. The iOS app is complete and works — but shipping it requires a paid Apple Developer account, which gates the App Store, iCloud sync, and two features outright. A web app is a URL.

**The rewrite is finished, and the iOS repository is now frozen.** It is not
abandoned: it still builds, its tests still run, and it remains the specification
this port was written against. It is simply no longer where work happens. Feature
ideas that were open there have been moved here as issues; the ones that were
blocked on a paid Apple account are no longer blocked.

The rewrite is not a port of the UI. SwiftUI does not run on the web and SwiftData does not exist there, so the interface is built fresh. What carries over is the part worth carrying: roughly 1,500 lines of domain logic, and the test suite that specifies it.

## Why the original's tests matter here

The iOS app ships 425 tests. They are the most precise description of this app's behaviour that exists, and they pin rules that are easy to get subtly wrong:

- **MPG is computed between full tanks, sorted by odometer — not by date.** A phone's clock can be wrong; an odometer only moves forward. The first full tank is a baseline with no MPG of its own, and partial fills roll their gallons into the next full-tank segment.
- **Average MPG is total miles ÷ total gallons**, never a mean of segment averages.
- **Cost per mile excludes the first fill-up's fuel** — that fuel was burned before tracking began.
- **A missed fill-up breaks the chain rather than producing a wrong number**, and the skipped fuel still counts toward spending.
- **Every write is validated once, in one place**, rejecting non-positive *and* non-finite values. `+Infinity` passes a `> 0` check; it must be rejected explicitly.
- **Storage is canonical** — miles, US gallons, US MPG — with conversion only at the display boundary. L/100km is the reciprocal of MPG, so a better car reads *lower*.
- **Date arithmetic clamps rather than rolling over.** Subtracting three months from 31 May gives 28 February, not 3 March. Swift's `Calendar` does this for you; JavaScript's `Date` does the opposite, and the difference is invisible — a rolled-over cutoff is simply *later* than intended, so a filtered list quietly drops its oldest rows and still looks right.

Those assertions are being ported alongside the code, not rewritten. A change in an assertion is treated as a bug in the port.

## Where the port deliberately differs

The iOS app is the specification, so a difference is a decision, not an
accident. Each one is recorded here and pinned by a test.

- **The weekday price insight requires a *finite* spread.** The original guards
  with `delta * 100 >= 1`, which is false for `NaN` but true for `+Infinity` —
  so an infinite price would render "You pay about $∞/gal less on Tuesdays than
  Fridays." iOS never shows it, because non-finite values are rejected at the
  write boundary and cannot reach the statistics layer. That makes it latent
  rather than live, but the point of the write guard is that a corrupted record
  must not poison a statistic, so the port closes the second hole as well.
- **The vehicle showdown carries no `icon` field.** The original names SF
  Symbols (`"leaf.fill"`, `"fuelpump.fill"`), which mean nothing off Apple's
  platforms. Each row's `id` already identifies it uniquely and its order is
  pinned by a test, so the interface layer maps `id` to whatever icon set it
  uses and the domain module stays platform-free.
- **Numeric fields keep the text you typed, not a re-rendered number.** A
  controlled input that round-trips through `Number` on every keystroke destroys
  a decimal as it is being entered: typing `3.5` parses `3.` to `3`, renders
  `3`, and the next keystroke appends to that — recording a price ten times too
  high, silently. The form holds the raw text and derives the number from it.
  There is no Swift equivalent because SwiftUI's `TextField` handles this; on
  the web it has to be done deliberately.
- **Demo data is deterministic.** The original's preview fixture calls
  `Double.random`, so every preview differs. That is fine for eyeballing a
  layout and wrong for everything else here: a demo that shows different numbers
  on each visit is confusing, and a fixture that changes between runs turns a
  real regression into a flake. A seeded generator produces the same twelve
  fill-ups every time, still scattered enough to look like a real car.
- **Calendar and locale are parameters, not ambient globals.** The original
  reads `Calendar.current` and `DateFormatter()`. Here the week's first day and
  the locale are arguments with deterministic defaults, so tests assert a literal
  expected week order rather than recomputing their expectation from the
  platform — the only way an assertion can catch a *numbering* mistake and not
  just a *rotation* one. (`Intl` reports the first weekday in ISO numbering,
  1 = Monday; everything else here uses 1 = Sunday.)

## Contrast is enforced, not asserted

The accent colours are not `orange` and `teal`. Stock palettes are tuned to look
right, not to pass a threshold, and measured against a white card the usual ones
land between **2.20:1 and 4.13:1** — every one of them below the 4.5:1 that WCAG
2.2 AA requires for text, and three below even the 3:1 that applies to chart
marks. So the lines and bars were unreadable, not just the labels.

`src/domain/accessiblePalette.ts` replaces them with values that clear the bar on
all three surfaces a colour can land on: the card, the page behind it, and its
own 15% tint wash. Colours are stored as **numeric components rather than CSS
strings**, for one reason — a string cannot be measured. `contrast.ts` recomputes
every ratio from those components on each CI run, against both the 4.5 standard
and the palette's own 4.7 margin, so a palette edit that breaks the promise fails
the build.

The wash is the trap worth knowing about. It is mixed from *the colour being
chosen*, so darkening the ink darkens its own background and the pair moves
together — it is the binding constraint every time, and the measured worst case
in the whole palette is **4.80:1**. Score a candidate against a wash mixed from
the stock colour instead and it reads 0.4 higher than what the app renders. That
mistake shipped once upstream and only CI caught it; two tests now pin the
recursion so a re-derivation cannot quietly optimise the looser problem.

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

### Signing in

Google sign-in, via Firebase Auth, and it is **required**. That reverses this
project's founding local-first decision, deliberately and at the owner's
request, and the cost is worth stating: a brand-new device with no network
cannot get in. After the first sign-in on a device it works fully offline,
because the session is persisted in IndexedDB and restored without a network
round-trip — which is also why the Firebase chunks are precached by the service
worker rather than excluded for their size. Without them an offline reload could
not restore the session, and the app would not open at all.

Settings → Account shows **your account id** — the uid Firebase knows you by —
with a button to copy it. It is there because it is the identifier that grants
access to a deployment, and the only other place to find it is the Firebase
console, which the person who needs to read it usually cannot open. It comes
from Auth rather than Firestore, so it stays readable even for somebody whose
data reads are all being refused.

Only non-sensitive profile scopes are requested (email and display name), so
there is no OAuth verification screen and no seven-day token expiry. That ruled
out the simpler-looking alternative of keeping one JSON file in the user's Google
Drive: `drive.appdata` is a sensitive scope, which caps an unverified app at 100
lifetime users and expires its tokens weekly.

### Who can sign in

Signing in with Google is not the same as being allowed in, and until #27 this
project treated it as if it were. Any Google account on earth could sign in and
write data under its own uid: `firestore.rules` confined a stranger to their own
tree, and then let them fill it — on this project's daily write quota, inside
its 1 GiB, and invisible to the owner, because nobody can read anybody else's
tree. Being bounded to your own corner is not the same as being admitted.

So `firestore.rules` now carries an **allowlist of uids**, and every read and
write is gated on it as well as on owning the path. An account that is not on
the list is refused everywhere, including in its own tree.

Uids rather than email addresses, for three reasons:

- A uid is opaque, so a public repository stays free of anybody's personal
  data. An allowlist of email addresses would publish other people's.
- A list literal costs nothing to evaluate. Looking an allowlist up with
  `exists()` would add a billed read to *every* request, which is a strange
  thing to spend on a rule about quota.
- A list a reader can see is a list a reviewer can check.

The cost is real and worth stating: **a uid does not exist until its owner has
signed in once.** To add somebody:

1. They sign in. The app loads and then cannot read anything — expected, and
   worth warning them about first.
2. Firebase console → Authentication → Users. Their row is now there; copy the
   **User UID** column.
3. Add it to the `allowed()` list in `firestore.rules`, in a pull request.
4. Merging deploys the rules (rules first, then hosting — see *Deploying*), and
   they can use the app on their next reload.

The rules suite reads that list **out of the rules file** rather than keeping
its own copy, so adding a person needs no test change, and emptying the list
fails the suite rather than silently locking everybody out. A separate check
fails while the list still holds a placeholder, which is what keeps a
switched-on-but-admitting-nobody allowlist off `main`.

Two things belong with this that no pull request can do, because they are
console settings:

- **Turn off new sign-ups** (Authentication → Settings → User actions). The
  allowlist refuses a stranger; this stops the account being created at all, so
  there is nothing to refuse and nothing accumulating in your user list.
- **Set a budget alert.** The free tier stops serving rather than charging, so
  the failure mode is the app going quiet, not a bill — but finding that out
  from a notification beats finding it out from a sync that stopped working.

Still not done, deliberately: **App Check**. The web config in the bundle is a
working client credential, and App Check is the mechanism that binds requests
to *this app* rather than to anyone who copied four strings out of the
JavaScript. The allowlist already stops an unknown account storing data, which
is the part that mattered; App Check would additionally stop a script hammering
the project's read quota using a known-good account's credentials. It needs a
reCAPTCHA integration plus a debug provider so the emulator suite and
`npm run dev` keep working, which is its own piece of work rather than a line
in this one.

### Signing out when the tab goes idle

Off by default, under Settings → Security: sign out after 5, 15, 30 or 60
minutes without a pointer or a keystroke. It exists because Firebase Auth
persists a session and never expires it, so a tab left open on a borrowed laptop
otherwise keeps access indefinitely.

What it does **not** do matters as much, and the setting says so next to the
switch rather than in a help page:

- **Signing out does not remove the fuel log.** The per-account database stays
  on the device on purpose, so signing back in finds the history and any edits
  that had not synced yet. Anyone who opens the browser's developer tools can
  still read it. This ends a session; it is a small addition to locking the
  device itself, which is the protection that actually matters.
- **Signing back in needs a connection.** A device that is offline cannot get
  back into the app until it reconnects. That is the trade for leaving this on,
  and it is why the default is off for an app that otherwise works offline.

The rule is a pure function (`domain/idleTimeout.ts`) and the browser part — the
activity marker, the events, the polling — is separate (`ui/idleTimeout.ts`), so
the thing that decides to end someone's session is tested directly rather than
inferred from a render. Two details are deliberate. The last-activity marker
lives in `localStorage`, so two tabs agree and nobody is signed out of the tab
they left open while they were working in the other one. And the fallbacks point
in **opposite directions on purpose**: an unreadable *period* becomes the
30-minute default, never "no timeout", because that failure would be invisible;
an unreadable *setting* reads as off, because there is then no evidence anybody
asked for this and signing them out would be an action they never requested.

### Local storage is separated by account

The IndexedDB database is named after the signed-in uid
(`fueltracker-u-<uid>`), and it is opened only once auth has resolved. That is a
fix, not a flourish: the first version of sign-in opened one database called
`fueltracker` for everyone, at module load, and never cleared it on sign-out. On
a shared computer that meant person B signing in got a store still holding
person A's rows — and the first sync exported them **into B's account**, where
they propagated to B's other devices.

Per-account names rather than clearing on sign-out, because clearing would
destroy local edits made before someone signed out and before a sync could carry
them up — turning a privacy fix into a data-loss one. Each person's rows stay on
the device under their own name, so signing back in finds them.

Data written before accounts existed is adopted once, into the first account to
sign in, and the legacy database is deleted only after the copy is verified by
row count. The adoption declines if the account already has rows, so it is a
one-time rescue rather than a rule that whoever signs in inherits whatever was
lying around. `accountStore.test.ts` covers all of that, including the leak
itself — and that test was checked by reverting the fix, to confirm it fails
against the old behaviour rather than merely passing against the new one.

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

**On write**, `firestore.rules` now validates shape as well as identity — field
names, types, string lengths and receipt size. Identity alone stops another
*user* and does nothing about a bad build or a console edit, and the size bounds
are what stop one junk field being inflated to the 1 MiB document cap and eating
the daily quota.

One consequence worth knowing before adding a field: the rules use `hasOnly`, so
an unknown field is refused. **New fields must be deployed to the rules before a
build that writes them** — change both in the same pull request.

The rules suite is 25 assertions against the emulator, including the positive
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

### Setting it up for your own project

The Firebase web config is public by design and still is not committed: the API
key matches gitleaks' Google-API-key pattern, and this project's policy is that
allowlisting a credential pattern is never the fix. Public does not mean
harmless, though: those four strings are a working client credential, and what
bounds their use is `firestore.rules` — the per-account scoping, the shape and
size limits, and the [sign-in allowlist](#who-can-sign-in). Not the obscurity
of the values, and not the app's own code, which anybody can bypass by talking
to Firestore directly. Copy `.env.example` to
`.env.local` and fill in the four values from the Firebase console. A checkout
with no config still builds, starts and passes its tests — the sign-in screen
says what is missing instead of offering a dead button.

**The config is baked in at build time.** Vite inlines `VITE_*` values into the
bundle, so the deployed site carries whatever environment was present when
`vite build` ran — not whatever is in `.env.local` now. Building without it
produces a site that loads and then says it has no backend.

### Deploying

Two package names matter here. The CLI is **`firebase-tools`**; `firebase` is
the SDK this app depends on and it ships no executable, so `npx firebase`
fails with "could not determine executable to run".

```bash
npx --yes firebase-tools login
npx --yes firebase-tools deploy --project <your-project-id>
```

Global installs land in a root-owned directory under a stock Node `.pkg`, which
fails with `EACCES`. Don't reach for `sudo` — it runs package install scripts as
root. Either use `npx` as above, or point npm somewhere you own:

```bash
npm config set prefix ~/.npm-global   # then add ~/.npm-global/bin to PATH
```

#### Deploys happen on merge

`.github/workflows/deploy.yml` publishes to Hosting on every push to `main`,
so the commands above are now the fallback rather than the routine. Two details
in it are load-bearing:

- **The four `VITE_FIREBASE_*` values are repository Variables, not Secrets.**
  They are public by design and ship inside the bundle, so storing them as
  secrets would imply a confidentiality the deployed site does not have. The
  service account key is a real secret and lives in Secrets as
  `FIREBASE_SERVICE_ACCOUNT`.
- **The workflow refuses to deploy if any of them is missing.** Vite inlines
  `VITE_*` at build time, so without them the build *succeeds* and produces a
  bundle with no backend — a live site that loads and then says it has no
  configuration. A red deploy is the better outcome, and a post-deploy smoke
  test greps the served JavaScript for the project id to confirm the
  configuration really was baked in rather than merely present on the runner.

Rules are deployed in a step of their own, **before** hosting, for the `hasOnly`
reason below. It is not a required check: it runs after merge, and a failed
deploy should not retroactively block the commit that caused it.

To set it up on a fork: generate a private key under Firebase console → Project
settings → Service accounts, paste the whole JSON into the
`FIREBASE_SERVICE_ACCOUNT` secret, add the four variables, and delete the
downloaded file — it is a long-lived credential with deploy rights.

Hosting carries a **`predeploy` hook** that runs `npm run build`, so a deploy
cannot ship a `dist/` that does not match the source. That guard is there for
the quiet failure rather than the loud one: a missing `dist/` stops the deploy
with an obvious error, but a *stale* one deploys perfectly happily and serves
last week's code with no sign that anything is wrong. The hook is scoped to the
hosting target, so `--only firestore:rules` stays fast and skips the build.

The rules deploy is not optional. A database created in production mode denies
everything until they are uploaded, so sign-in succeeds and then every read
fails with permission-denied. `firebase deploy` with no `--only` covers both.

Two formats, two jobs. The **JSON backup** is the complete one — every vehicle,
every fill-up, receipt bytes, and the deletions too — and importing it **merges
rather than replaces**, matching rows by id and keeping whichever was edited
more recently. So restoring last week's backup cannot destroy this morning's
correction, and importing the same file twice does nothing the second time. The
**CSV** is for spreadsheets: fill-ups only, in canonical miles and US gallons
whatever units you have selected, with the unit named in every column heading —
because a file whose meaning depends on a setting that is not in the file is a
file you will misread a year from now.

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

## Charts, and why they are hand-drawn

Six charts, in plain SVG, for **2.5 KB gzipped**. A charting library would have
been roughly forty times that — about double the whole bundle — for six simple
series, on an app meant to work offline on a phone.

The other reason is the accessibility tree. The iOS app pairs each chart with an
**audio graph**: VoiceOver plays the shape of a series as sound. The web has no
equivalent, so that has to be made up elsewhere, and owning the markup is what
makes it possible:

- the drawing is one `role="img"` labelled with a **spoken summary** — how many
  points, the range, the average, the latest value, and the direction — so the
  gist arrives in one sentence instead of after walking every mark;
- the SVG itself is `aria-hidden`, because dozens of unlabelled `path` and
  `circle` nodes are an obstacle, not information;
- beside it sits a real `<table>` of every point, behind a "Show the numbers"
  disclosure. A table announces its own row and column headers and can be read
  in any order, which a bag of labelled SVG marks cannot.

Three drawing decisions are about honesty rather than looks. **Lines are
straight**, not splined — a smooth curve invents values between marks that were
never measured. **Bars start at zero**, because a bar's length is read as a
quantity and a truncated one lies about proportion. **The weekday price plot
uses dots on a zoomed axis**, because gas is never $0: a zero-based bar chart
would bury the cent-level differences that are the entire point, while a
truncated bar would exaggerate them. A dot makes no claim about proportion, so
the axis is free to start where the data does.

And the economy chart is **converted, not relabelled**. L/100km is the
reciprocal of MPG, so the same car's curve genuinely inverts: 35 → 45 MPG
"trending up" is 6.7 → 5.2 L/100km "trending down". Swapping the axis label over
the same points would draw the opposite of the truth.

## Security headers, and what the app actually talks to

Hosting sets `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`,
a `Permissions-Policy` granting nothing (the app uses no camera, microphone or
geolocation — receipts arrive through a file input and GPS was dropped in the
port), and `Cross-Origin-Opener-Policy: same-origin-allow-popups`.

That last value is deliberate and worth knowing. The stricter `same-origin`
severs `window.opener` and **breaks `signInWithPopup`** — the single most likely
way a headers change takes this app down, and a failure that appears only on the
deployed site. There is a test asserting it is not that value, with the reason
in the assertion.

The Content-Security-Policy ships as **`Content-Security-Policy-Report-Only`
first**. The browser evaluates it and logs violations without blocking
anything, so the real flows can be exercised before it is enforced. A policy
written without being able to load the deployed site is a guess, and the
failure mode of a wrong guess is being locked out of your own app.

`script-src` is `'self'` with no nonce or hash machinery, which is possible only
because the built page carries no inline script. Nothing in the build enforces
that — Vite happens to emit a single `<script src>` — so a test does, since the
alternative is discovering it in production.

### The one third-party request

Scanning a receipt fetches tesseract.js's worker, its wasm core and the English
language data from **`cdn.jsdelivr.net`**, at scan time. `createWorker('eng')`
takes no paths, and those defaults live inside the library, so nothing in this
repository's own source mentions the domain. It means jsdelivr learns that
somebody started a scan — not the image, not the result — and that scanning
fails where that CDN is blocked.

Everything else is same-origin apart from Google's own endpoints for auth and
Firestore. Self-hosting the tesseract assets would remove the dependency and
costs several megabytes of hosting transfer per scan; it has not been done, and
this paragraph is the honest version of that choice.

## Installing it, and using it offline

It is a progressive web app: install it from your browser's menu and it gets a
home-screen icon and its own window, with no app store in between. Once
installed it works with **no network at all** — the shell is precached and the
data was never on a server to begin with. Verified rather than assumed: with the
network cut, the app loads, shows your history, and logs a new fill-up.

Updates **ask before they apply**. The conventional setting activates a new
version and reloads the moment one arrives, which would discard a fill-up
someone was halfway through typing — and since this app holds the only copy of
their data, that is a bad trade for saving them a click.

## What this version cannot do

Stated up front rather than discovered later:

| Capability | Status |
|---|---|
| **Live camera scanning** | **Gone.** The iOS app reads a pump display in real time via on-device Vision. Browser OCR is orders of magnitude slower and weaker on seven-segment digits, so scanning becomes snap-a-photo. |
| **Apple Watch app** | **Gone.** No equivalent. |
| **Encryption at rest** | **Gone.** iOS gives per-file encryption keyed to the device passcode. Browser storage has no equivalent. |
| **Biometric app lock** | **Degraded.** WebAuthn is a different primitive with no passcode fallback, so there is no Face ID equivalent. What ships instead is an optional [idle timeout](#signing-out-when-the-tab-goes-idle) — off by default — that ends the session after a period of inactivity. It is honestly weaker: it gates the session, not the data, which stays on the device and stays readable in developer tools. |
| **GPS station detection** | **Dropped.** Receipt brand-name matching still works — that's text, not location. |
| **Pump display scanning** | **Dropped on evidence.** Seven-segment digits defeat the recogniser even undegraded — confidence 36, no usable output. The pump parser stays, because it costs nothing and reads a receipt's fuel line. |
| **Bounded image decode** | **Degraded.** iOS decodes an untrusted photo straight to a bounded size and never builds the full bitmap, which is what stops a decompression bomb. The web has no equivalent primitive, so the defence is a byte ceiling checked *before* any decode plus a bounded re-encode after. A large-but-legitimate-looking file that expands hugely remains a gap. |

Gained in exchange: it runs on any device with a browser, costs nothing to publish, and needs no account.

## What was deliberately not built

The table above is what the platform took away. This is the shorter, more
honest list: things that were possible and were **chosen against**.

- **~~No sync and no accounts.~~ Built after all, and the entry above is kept
  rather than deleted because the reasoning is still the honest account of what
  it cost.** The founding decision was local-first, and sync reverses it: there
  is now an account to lose access to, and a Google dependency where there was
  none. What the original note got right is that it would be cheap when it came
  — the four sync fields were stamped on every row from the first write, nothing
  had to be migrated, and the merge rule was already written and tested. What it
  got wrong is the bill: Firestore's free tier needs no card and stops serving
  rather than charging, so the monthly bill never materialised. The privacy
  claim at the top of this file is no longer structural — there is now a server
  to trust, and `firestore.rules` is what makes it trustworthy.
- **No multi-user sharing.** Sync is strictly one person's data across their own
  devices. The rules grant access to `users/{uid}` and nothing else, so the
  shareable-submission link (issue #3) still needs its transport designed; the
  data model for it is built and tested, with no UI on it.
- **No pump-display scanning.** Dropped on measurement, not on principle. A
  seven-segment pump display rendered *pristinely* — no glare, no angle, no
  blur — came back at confidence 36 with the output `GAL =, ( (CZ`. A scanner
  that is wrong is worse than no scanner, because a plausible wrong number is
  harder to notice than a blank field.
- **No PDF export.** CSV and JSON cover the two real jobs — a spreadsheet and a
  restore — and a PDF is neither.
- **No shareable submission link.** The submit → review → approve data model is
  built and tested; only the transport is missing, and on the web a URL *is* the
  transport, so this is now genuinely buildable. It is
  [issue #3](https://github.com/kja031199/fueltracker-web/issues/3) rather than
  something abandoned — but a public endpoint anyone can open raises questions
  (scope, revocation, rate limiting) that `CKShare` used to answer for free.

## One thing inherited that is probably wrong

Worth writing down where someone will find it, because the port did not
introduce it and did not fix it either.

**`monthlyTotals` reports the odometer span *within* a calendar month.** So a
month containing a single fill-up reports **0 miles driven**, even though the car
plainly moved in order to be at a pump. It is faithful to the original — the KPI
cards simply never displayed it, and the monthly-distance chart does, which is
how it surfaced. Fixing it means deciding what "miles in January" should mean for
a car driven across a month boundary, and that is a product decision rather than
a bug fix, so it is recorded rather than quietly changed.

One more limit worth stating plainly: **scanning is US-only by design.** The
pump and receipt parsers are tuned to US pumps — the plausible value bands are
gallons and dollars, distances are miles, and the `9/10` fraction-of-a-cent
notation is a US convention. That caveat is inherited from the iOS app, but it
matters more here, because a web app reaches people an iPhone-only app never
did. Manual entry supports every unit; only scanning is narrow.

## Development

```bash
npm install
npm run dev        # vite dev server
npm test           # vitest
npm run typecheck  # tsc --noEmit
npm run build      # typecheck, then a production build
```

Component tests opt into a DOM per file with a `@vitest-environment jsdom`
docblock. The domain and storage suites stay on the node environment, which
starts faster and needs nothing a browser provides — the cost of a DOM is paid
only where it buys something.

## What the dependency audit says, and what was accepted

`npm ci` reports vulnerabilities. They have been assessed rather than ignored or
blanket-fixed, and the conclusion is recorded here so the number means something
to the next person who sees it.

**None of them reaches a browser.** That was checked, not assumed: grepping the
built chunks for `grpc-js`, `undici`, `source-map-js`, `serialize-javascript`,
`fast-uri` and `ejs` finds zero references in any of them.

Most are build tooling and test infrastructure — vite, vitest, workbox-build and
its rollup plugins — which run on a developer's machine and on CI runners, never
in anyone's browser.

**Four are in the production tree and all are one root cause**:
`@grpc/grpc-js`, reached through `@firebase/firestore`. They are **accepted**,
for three reasons together:

1. `grpc-js` is Firestore's **Node** transport. `@firebase/firestore`'s
   `exports` map sends the `browser` condition to a different entry that uses
   WebChannel over HTTPS, so it is not in the bundle at all.
2. Both advisories concern a gRPC **server** mishandling certificates and
   leaking handler errors to clients. This project runs no server. The only
   place grpc-js executes here is the rules test suite, in Node, against a local
   emulator.
3. **There is no fix to apply.** `npm audit` reports one as available, but
   `firebase` is already at the latest published version, so the "fix" resolves
   to a major change that would most plausibly *downgrade* it — making the app
   less current while reporting success. This is the concrete reason
   `npm audit fix --force` is not run here.

Revisit when `firebase` publishes a release that moves off the affected
`@grpc/grpc-js`.

**Tried and rejected:** `vite-plugin-pwa` 1 → 2, on the theory that it would
pull a newer workbox and clear eight findings at once. It does not — 2.0.0
depends on the same `workbox-build` 7.4.1. A major version bump with no security
benefit is risk paid for nothing, so it was reverted.

## Automated checks

Three checks run on every pull request and every push to `main`. None of them
skip, so all three always report a status — which is what makes them safe to
require.

| Check | What fails it |
|---|---|
| **Typecheck, test & build** | A type error, a ported assertion no longer holding, or an app that no longer builds |
| **Secret scan** (gitleaks) | A credential-shaped string in **any commit**, not just the diff |
| **Docs links** (lychee) | A broken relative link or `#heading-anchor` in Markdown |

The link check is `--offline` on purpose: it validates on-disk targets and
anchors, and skips external URLs so a third party's server being down can never
stand between a correct change and `main`.

`npm ci` is used rather than `npm install` — it installs exactly what the
lockfile pins and fails if the lockfile and manifest disagree, instead of
silently resolving a different tree.

## Licence

Apache-2.0 — see [LICENSE](LICENSE). Two things the bare licence doesn't say are in [NOTICE](NOTICE): the name and branding are not part of the grant, and **most of this repository was written by Claude**, an AI assistant, under the copyright holder's direction.
