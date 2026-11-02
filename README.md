# FuelTracker Web

[![CI](https://github.com/kja031199/fueltracker-web/actions/workflows/ci.yml/badge.svg)](https://github.com/kja031199/fueltracker-web/actions/workflows/ci.yml)

Track gas fill-ups and fuel economy in your browser. **Sign in with Google; your fuel log is stored on your device and synced to your own account.** No analytics, no third party, and nobody but you can read it.

> **Status: complete, now with an account.** Add vehicles, log and edit
> fill-ups, search and filter them, see your economy, spending and price trends
> as KPIs and charts, **export a backup you can restore**, **install it and use
> it with no network at all**, **photograph a receipt** to fill the form in, and
> **sign in with Google so your log survives a cleared browser and follows you
> to your phone**. There is a test file beside nearly every module, plus a suite
> that runs the security rules against the Firestore emulator. What is *not*
> here was left out on purpose, not left unfinished — see
> [what was deliberately not built](docs/port.md#what-was-deliberately-not-built).

## What this is

A web rewrite of [FuelTracker](https://github.com/kja031199/FuelTrackingApp), a native iOS + watchOS app by the same author. The iOS app is complete and works — but shipping it requires a paid Apple Developer account, which gates the App Store, iCloud sync, and two features outright. A web app is a URL.

**The rewrite is finished, and the iOS repository is now frozen.** It is not
abandoned: it still builds, its tests still run, and it remains the specification
this port was written against. It is simply no longer where work happens. Feature
ideas that were open there have been moved here as issues; the ones that were
blocked on a paid Apple account are no longer blocked.

The rewrite is not a port of the UI. SwiftUI does not run on the web and SwiftData does not exist there, so the interface is built fresh. What carries over is the part worth carrying: roughly 1,500 lines of domain logic, and the test suite that specifies it.

## Running it

```bash
npm install
npm run dev        # vite dev server
npm test           # vitest
npm run build      # typecheck, then a production build
```

It runs with no configuration: without a Firebase config the sign-in screen
says what is missing rather than offering a dead button. To point a checkout at
your own project, see [docs/deploying.md](docs/deploying.md). A development
build refuses the production project, so local work needs a
[development project of its own](docs/deploying.md#local-development-uses-its-own-project).

## Documentation

The detail lives in [`docs/`](docs/), one file per subject:

| | |
|---|---|
| [docs/port.md](docs/port.md) | Why this is a web app, what the rewrite kept, what the platform took away, and what was left out on purpose |
| [docs/accounts.md](docs/accounts.md) | Signing in, who is allowed to, the idle timeout, and per-account storage |
| [docs/sync.md](docs/sync.md) | How two devices reconcile, what a deletion deletes, and why nothing from the account is trusted |
| [docs/deploying.md](docs/deploying.md) | Your own Firebase project, the deploy on merge, and the supply chain around the one credential |
| [docs/security.md](docs/security.md) | Security headers, the one third-party request, and the dependency audit |
| [docs/interface.md](docs/interface.md) | Measured contrast, hand-drawn charts, installing and offline |
| [docs/development.md](docs/development.md) | Local commands and the checks every pull request goes through |

[`CLAUDE.md`](CLAUDE.md) is the operating manual for an AI assistant working
here: the invariants, and the traps already fallen into.

## Licence

Apache-2.0 — see [LICENSE](LICENSE). Two things the bare licence doesn't say are in [NOTICE](NOTICE): the name and branding are not part of the grant, and **most of this repository was written by Claude**, an AI assistant, under the copyright holder's direction.
