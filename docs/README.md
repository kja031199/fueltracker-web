# Documentation

One file per subject. The root [`README.md`](../README.md) is the overview and
how to run it; everything here is the detail behind it.

- **[port.md](port.md)** — why this is a web app at all, what the rewrite kept
  from the frozen iOS original, what the browser took away, and the list of
  things left out on purpose rather than left unfinished.
- **[accounts.md](accounts.md)** — signing in with Google, the allowlist that
  decides who may, the optional idle timeout, and why local storage is
  separated per account.
- **[sync.md](sync.md)** — where the data lives, how two devices reconcile,
  what a deletion actually deletes, the logical clock, and why nothing arriving
  from the account is believed without being checked.
- **[deploying.md](deploying.md)** — pointing a checkout at your own Firebase
  project, the deploy that runs on merge, the pinned deploy toolchain, and the
  Workload Identity decision.
- **[security.md](security.md)** — the security headers, the one third-party
  request the app makes, and what the dependency audit says, including what was
  accepted rather than fixed.
- **[interface.md](interface.md)** — contrast that is measured rather than
  asserted, charts drawn by hand, and installing it for offline use.
- **[development.md](development.md)** — local commands, and the four checks
  every pull request goes through.

For an AI assistant working in this repository, [`CLAUDE.md`](../CLAUDE.md)
holds the invariants and the traps.
