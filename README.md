# FuelTracker Web

[![CI](https://github.com/kja031199/fueltracker-web/actions/workflows/ci.yml/badge.svg)](https://github.com/kja031199/fueltracker-web/actions/workflows/ci.yml)

Track gas fill-ups and fuel economy in your browser. **Local-first: no account, no server, no analytics.** Your data stays in your browser.

> **Status: early.** The domain layer is complete and tested — 354 assertions covering every rule below — but there is no user interface yet, and nothing is stored anywhere. Not usable for real fuel logging.

## What this is

A web rewrite of [FuelTracker](https://github.com/kja031199/FuelTrackingApp), a native iOS + watchOS app by the same author. The iOS app is complete and works — but shipping it requires a paid Apple Developer account, which gates the App Store, iCloud sync, and two features outright. A web app is a URL.

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

## What this version cannot do

Stated up front rather than discovered later:

| Capability | Status |
|---|---|
| **Live camera scanning** | **Gone.** The iOS app reads a pump display in real time via on-device Vision. Browser OCR is orders of magnitude slower and weaker on seven-segment digits, so scanning becomes snap-a-photo. |
| **Apple Watch app** | **Gone.** No equivalent. |
| **Encryption at rest** | **Gone.** iOS gives per-file encryption keyed to the device passcode. Browser storage has no equivalent. |
| **Biometric app lock** | **Degraded.** WebAuthn is a different primitive with no passcode fallback. |
| **GPS station detection** | **Dropped.** Receipt brand-name matching still works — that's text, not location. |

Gained in exchange: it runs on any device with a browser, costs nothing to publish, and needs no account.

One more limit worth stating plainly: **scanning is US-only by design.** The
pump and receipt parsers are tuned to US pumps — the plausible value bands are
gallons and dollars, distances are miles, and the `9/10` fraction-of-a-cent
notation is a US convention. That caveat is inherited from the iOS app, but it
matters more here, because a web app reaches people an iPhone-only app never
did. Manual entry supports every unit; only scanning is narrow.

## Development

```bash
npm install
npm test           # vitest
npm run typecheck  # tsc --noEmit
```

## Automated checks

Three checks run on every pull request and every push to `main`. None of them
skip, so all three always report a status — which is what makes them safe to
require.

| Check | What fails it |
|---|---|
| **Typecheck & test** | A type error, or any ported assertion no longer holding |
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
