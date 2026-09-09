# FuelTracker Web

[![CI](https://github.com/kja031199/fueltracker-web/actions/workflows/ci.yml/badge.svg)](https://github.com/kja031199/fueltracker-web/actions/workflows/ci.yml)

Track gas fill-ups and fuel economy in your browser. **Local-first: no account, no server, no analytics.** Your data stays in your browser.

> **Status: early.** The domain layer is being ported and tested; there is no user interface yet. Not usable for real fuel logging.

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

Those assertions are being ported alongside the code, not rewritten. A change in an assertion is treated as a bug in the port.

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
