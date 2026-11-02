# Setting it up and deploying

Pointing a checkout at your own Firebase project, the deploy that happens on
merge, and the supply chain around the one credential this repository holds.

## Setting it up for your own project

The Firebase web config is public by design and still is not committed: the API
key matches gitleaks' Google-API-key pattern, and this project's policy is that
allowlisting a credential pattern is never the fix. Public does not mean
harmless, though: those four strings are a working client credential, and what
bounds their use is `firestore.rules` — the per-account scoping, the shape and
size limits, and the [sign-in allowlist](accounts.md#who-can-sign-in). Not the obscurity
of the values, and not the app's own code, which anybody can bypass by talking
to Firestore directly. Copy `.env.example` to
`.env.local` and fill in the four values from the Firebase console. A checkout
with no config still builds, starts and passes its tests — the sign-in screen
says what is missing instead of offering a dead button.

**The config is baked in at build time.** Vite inlines `VITE_*` values into the
bundle, so the deployed site carries whatever environment was present when
`vite build` ran — not whatever is in `.env.local` now. Building without it
produces a site that loads and then says it has no backend.

## Deploying

Two package names matter here. The CLI is **`firebase-tools`**; `firebase` is
the SDK this app depends on and it ships no executable, so `npx firebase`
fails with "could not determine executable to run".

```bash
npx --yes firebase-tools login
npx --yes firebase-tools deploy --project <your-project-id>
```

Those are the by-hand commands, and `npx` is fine for them: no credential of
this repository's is involved, and a human is watching. CI uses a pinned copy
instead — see *The deploy toolchain is pinned* below.

Global installs land in a root-owned directory under a stock Node `.pkg`, which
fails with `EACCES`. Don't reach for `sudo` — it runs package install scripts as
root. Either use `npx` as above, or point npm somewhere you own:

```bash
npm config set prefix ~/.npm-global   # then add ~/.npm-global/bin to PATH
```

### Deploys happen on merge

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

### The deploy toolchain is pinned

CI does **not** use `npx --yes firebase-tools`. That resolved whatever version
was newest at the moment the job ran, downloaded it with several hundred
transitive dependencies, and executed it in a process holding the
service-account key — and because it was not in any `package.json`, it was not
in a lockfile either, so nothing verified it and Dependabot could not see it.
The one dependency trusted with a credential was the only one with no version
floor and no update review (#30).

It now lives in `.github/firebase-cli/`, with its own `package.json` pinning an
exact version and its own lockfile covering all 622 packages with integrity
hashes. Both the deploy job and the **rules** job install it with `npm ci`, so
the version that holds the credential on merge is exercised by a required check
on every pull request first.

Its own manifest rather than a devDependency of the app, deliberately: it is
needed in two jobs, it would add 622 packages to an install that every other
job performs, and it would change what `npm audit` reports about the tree that
actually ships — which the assessment in #19 went to some trouble to pin down.

What pinning does **not** do is make the tool's own tree clean. It has 16
moderate advisories, and they were always there: `npx` installed the same tree
and simply hid it. Worth knowing before reaching for `npm audit fix` in that
directory, because the same trap #19 found in the app's tree is there too —
npm offers **firebase-tools 13.11.2** as the "fix" for ten of the sixteen,
which is two majors *backwards* from the pinned 15.34.2. It would report
success while making the deploy tool older.

The real mitigation for a credential sitting next to that much code is not to
have a long-lived credential at all — see below.

### Workload Identity Federation, considered and deferred

GitHub can mint a short-lived OIDC token per run and exchange it for Google
credentials, which would remove the stored service-account key from this
repository entirely. It is the right end state and it is **not** done here, for
one reason: it needs setup on the Google side that no pull request can perform —
a Workload Identity Pool and provider, plus bindings on the `github-deploy`
service account restricted to this repository and branch. A half-configured
auth change does not degrade, it takes the deploy down.

One wrinkle worth planning for: the usual recipe uses
`google-github-actions/auth`, which would put a third-party action in the
credential path — the exact thing `deploy.yml` avoids today by writing the key
itself with `printf`. The exchange is three HTTPS calls and can be hand-rolled
with `curl` to keep that property.

Until then the key is mitigated rather than removed: the `github-deploy`
account holds only Hosting Admin, Rules Admin and Service Usage Consumer; it is
written with `printf` so nothing in the JSON is interpreted; `rm -f` runs under
`if: always()`; and the tests run **before** the key is written, so a compromised
test dependency never sees it.
