# Documentation

One file per subject. The root [`README.md`](../README.md) is the overview and
how to run it; everything here is the detail behind it.

- **[port.md](port.md)** — why this is a web app at all, what the rewrite kept
  from the frozen iOS original, what the browser took away, and the list of
  things left out on purpose rather than left unfinished.
- **[accounts.md](accounts.md)** — signing in with Google, the allowlist that
  decides who may, the admin-set idle timeout, and why local storage is
  separated per account.
- **[sync.md](sync.md)** — where the data lives, how two devices reconcile,
  what a deletion actually deletes, the logical clock, and why nothing arriving
  from the account is believed without being checked.
- **[deploying.md](deploying.md)** — pointing a checkout at your own Firebase
  project, the separate project local development has to use, the deploy that runs on merge, the pinned deploy toolchain, and the
  Workload Identity decision.
- **[security.md](security.md)** — the security headers, the one third-party
  request the app makes, and what the dependency audit says, including what was
  accepted rather than fixed.
- **[csp-check.md](csp-check.md)** — the five-minute browser check that has to
  happen before the Content-Security-Policy can be enforced, and the console
  helpers that make its answer exact.
- **[interface.md](interface.md)** — contrast that is measured rather than
  asserted, charts drawn by hand, and installing it for offline use.
- **[development.md](development.md)** — every local command, the checks
  every pull request goes through, testing rules, mutation testing, and how
  release notes are kept.

What each update changed is in [`RELEASE_NOTES.md`](../RELEASE_NOTES.md).

For an AI assistant working in this repository, [`CLAUDE.md`](../CLAUDE.md)
holds the invariants and says where every other rule lives.
