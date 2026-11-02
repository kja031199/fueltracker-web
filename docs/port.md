# The port, and what it cost

Why this exists as a web app at all, what the rewrite kept, what the platform
took away, and what was left out on purpose. The iOS original is frozen and
serves as the specification; this is the honest accounting of the difference.

## Why the original's tests matter here

The iOS app ships 425 tests. They are the most precise description of this app's behaviour that exists, and they pin rules that are easy to get subtly wrong:

- **MPG is computed between full tanks, sorted by odometer — not by date.** A phone's clock can be wrong; an odometer only moves forward. The first full tank is a baseline with no MPG of its own, and partial fills roll their gallons into the next full-tank segment.
- **Average MPG is total miles ÷ total gallons**, never a mean of segment averages.
- **Cost per mile excludes the first fill-up's fuel** — that fuel was burned before tracking began.
- **A missed fill-up breaks the chain rather than producing a wrong number**, and the skipped fuel still counts toward spending.
- **A date range windows the figures, not the fill-ups** (#51, a web-only addition). The chain always runs over the whole history. A segment counts in the range it *ends* in. Distance runs from the last fill-up before the range, and suspect segments are judged against the whole history's norm. Spending, counts and prices come from fill-ups dated in the range. Filtering the rows first, which is what the dashboard used to do, threw away the segment that crosses into the range: a range holding one fill-up showed no economy at all.
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

## What this version cannot do

Stated up front rather than discovered later:

| Capability | Status |
|---|---|
| **Live camera scanning** | **Gone.** The iOS app reads a pump display in real time via on-device Vision. Browser OCR is orders of magnitude slower and weaker on seven-segment digits, so scanning becomes snap-a-photo. |
| **Apple Watch app** | **Gone.** No equivalent. |
| **Encryption at rest** | **Gone.** iOS gives per-file encryption keyed to the device passcode. Browser storage has no equivalent. |
| **Biometric app lock** | **Degraded.** WebAuthn is a different primitive with no passcode fallback, so there is no Face ID equivalent. What ships instead is an optional [idle timeout](accounts.md#signing-out-when-the-tab-goes-idle) — off by default — that ends the session after a period of inactivity. It is honestly weaker: it gates the session, not the data, which stays on the device and stays readable in developer tools. |
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
