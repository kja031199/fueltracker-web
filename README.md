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

**Export is still worth doing.** A backup file is the only copy that does not
depend on somebody else's service staying up, or on you keeping access to that
Google account.

### Signing in

Google sign-in, via Firebase Auth, and it is **required**. That reverses this
project's founding local-first decision, deliberately and at the owner's
request, and the cost is worth stating: a brand-new device with no network
cannot get in. After the first sign-in on a device it works fully offline,
because the session is persisted in IndexedDB and restored without a network
round-trip — which is also why the Firebase chunks are precached by the service
worker rather than excluded for their size. Without them an offline reload could
not restore the session, and the app would not open at all.

Only non-sensitive profile scopes are requested (email and display name), so
there is no OAuth verification screen and no seven-day token expiry. That ruled
out the simpler-looking alternative of keeping one JSON file in the user's Google
Drive: `drive.appdata` is a sensitive scope, which caps an unverified app at 100
lifetime users and expires its tokens weekly.

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

Sync runs on sign-in, on window focus, and on demand from Settings. There is no
realtime listener and no sync-per-keystroke — the free tier allows 20,000 writes
a day, which is enormous for one person's fuel log right up until something
syncs in a loop, and an app that stops working at 4pm because it burned its
quota is a worse failure than one that is a few seconds stale.

### Receipt photos are the exception

Since 3 February 2026 Firebase Cloud Storage requires a linked billing account
even at zero usage, so the natural home for image blobs is off the free tier.
Receipts ride inside their fill-up document as Firestore `Bytes` instead, which
works because `receiptImage.ts` already bounds them at 1600px and quality 0.7 —
usually 200–500 KB, against a 1 MiB document cap.

Usually is not always. A receipt over 700 KB is pushed **without** the image and
reported, so the fill-up syncs and the photo stays on the device that took it.
Two consequences, both deliberate: a large photo is the one thing a cleared
browser can still lose, and an incoming row never *removes* a receipt the local
copy has — otherwise an edit made on a second device would overwrite the only
remaining copy of the image with null.

### Setting it up for your own project

The Firebase web config is public by design and still is not committed: the API
key matches gitleaks' Google-API-key pattern, and this project's policy is that
allowlisting a credential pattern is never the fix. Copy `.env.example` to
`.env.local` and fill in the four values from the Firebase console. A checkout
with no config still builds, starts and passes its tests — the sign-in screen
says what is missing instead of offering a dead button.

```bash
npx firebase deploy --only hosting,firestore:rules
```

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
| `deletedAt` | A **tombstone, not a row deletion**. A hard delete leaves nothing to propagate, so a row deleted on one device reappears from another. |
| `schemaVersion` | Stamped at write time so a future migration knows what shape it is reading. |

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
| **Biometric app lock** | **Degraded.** WebAuthn is a different primitive with no passcode fallback. Google sign-in is now the gate instead, which is a different thing: it protects the account, not the open tab. |
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
