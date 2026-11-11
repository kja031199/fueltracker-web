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

## Local development uses its own project

A development build **refuses the production project** (#45). If `.env.local`
names `fueltracker-899eb` and the page is either served by the Vite dev server
(`import.meta.env.DEV`, which also covers `vite --host` on a LAN address) or
loaded from this machine (`localhost`, `*.localhost`, `127.x.x.x`, `[::1]`,
`0.0.0.0` — which covers `vite preview`), the app starts nothing — no sign-in,
no sync, no local database — and says so. There is no override, on purpose.

Why: before this, `npm run dev` signed in to and synced with the real fuel log,
so a bug in an unreviewed change — a tombstone scrub, an id rule, a sync edit —
ran against production data before any pull request existed. And `localhost`
had to be an authorized sign-in domain on production, so any page served on the
owner's machine could open a genuine Google popup for it.

### Setting up a development project (about five minutes, free)

1. In the [Firebase console](https://console.firebase.google.com/), **Add
   project** — e.g. `fueltracker-dev`. Analytics is not needed. The free Spark
   plan has no billing, so there is nothing to cap.
2. **Build → Authentication → Get started → Google**, enable it. `localhost`
   is an authorized domain on a new project by default.
3. **Build → Firestore Database → Create database**, production mode, any
   region.
4. **Project settings → Your apps → Web (`</>`)**, register an app, and copy
   its four config values into `.env.local` (from `.env.example`).
5. Run `npm run dev` and sign in. You will land on the **no-access screen**:
   that is correct. **Uids are per project**, so your development uid is not
   your production one, and the allowlist in `firestore.rules` does not know it
   yet. Copy the id the screen shows.
6. Add that uid to the `allowed()` list in `firestore.rules` with a comment
   saying it is the development project's, and deploy the rules there with the
   pinned CLI:

   ```bash
   npm ci --prefix .github/firebase-cli
   .github/firebase-cli/node_modules/.bin/firebase login
   .github/firebase-cli/node_modules/.bin/firebase deploy \
     --only firestore:rules --project <your-dev-project-id>
   ```

   Committing that uid is harmless — like the others it is opaque, and it is
   meaningless to the production project — and committing it means the same
   rules file deploys to both. Then **Try again** on the no-access screen.

The [Firestore emulator](development.md) is the alternative when you only need
the rules, not a real sign-in: `src/data/firebase/rules.emulator.test.ts` already runs
against it with a throwaway project id.

### And on production: remove `localhost`

The guard stops *this app* reaching production from a development build; it
cannot stop a hand-written page on your machine that copies the public config.
That needs the second layer, in the production project's console:
**Authentication → Settings → Authorized domains → remove `localhost`**. After
that, a sign-in attempt for production from any local page fails with
`auth/unauthorized-domain`, whatever code is running.

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
  service account key is a real secret, `FIREBASE_SERVICE_ACCOUNT`, and lives
  only in the `production` **environment** — see
  [The deploy environment](#the-deploy-environment-76).
- **The workflow refuses to deploy if any of them is missing.** Vite inlines
  `VITE_*` at build time, so without them the build *succeeds* and produces a
  bundle with no backend — a live site that loads and then says it has no
  configuration. A red deploy is the better outcome, and a post-deploy smoke
  test greps the served JavaScript for the **app id** to confirm the
  configuration really was baked in rather than merely present on the runner.
  Not the project id: since #45 that is a constant in the source, so every
  bundle carries it, configured or not.
- **`VITE_IDLE_TIMEOUT_MINUTES` is the one optional Variable** (#70): the
  inactivity sign-out for everyone, in whole minutes. It is deliberately left
  out of the missing-configuration check, because unset — or anything that is
  not whole minutes — already means 30, never "no timeout". Held to 1–1440, and
  there is no "off". A change takes effect on the next deploy.
  `toolchain.test.ts` fails if the workflow stops passing it to the build,
  which would otherwise ignore the Variable without a word.

Rules are deployed in a step of their own, **before** hosting, for the `hasOnly`
reason below. It is not a required check: it runs after merge, and a failed
deploy should not retroactively block the commit that caused it.

### The deploy key never meets the build (#76)

The workflow is two jobs, and the split is what protects the key:

- **`build`** installs the app's dependencies — several hundred packages,
  lifecycle scripts included — checks the Variables, builds, runs the tests,
  and uploads `dist/` as an artifact. It holds **no secret**.
- **`deploy`** (`needs: build`, environment `production`) is the only job that
  can read the key, and it runs **no app-tree npm code**:
  - the Firebase CLI is installed with `npm ci --ignore-scripts` from its own
    lockfile — nothing in it needs an install script to deploy;
  - the tested `dist/` is downloaded, not rebuilt;
  - `firebase.json`'s `predeploy` hook is stripped into a generated
    `firebase.ci.json` (gitignored), and both deploys pass `--config` it;
  - the key is written only after all of that.

It used to be one job: `npm ci`'s lifecycle scripts ran first, and the hosting
deploy's `predeploy` hook ran `npm run build` — vite and every plugin — with the
key on disk. One compromised build dependency could have deployed wide-open
rules or its own JavaScript. `src/test/workflows.test.ts` asserts each part of
the split, and that no other job anywhere reads a secret.

### The deploy environment (#76)

The key is an **environment secret**, not a repository secret. A repository
secret is readable by any workflow on any branch — a branch that edits
`deploy.yml`, or a manual run of it from another branch, could read it.
One-time setup, on this repository or a fork:

1. **Settings → Environments → New environment**, named `production`.
2. **Deployment branches and tags → Selected branches and tags** → add `main`.
   No required reviewers: merges to `main` already need the four checks.
3. In that environment, **add secret** `FIREBASE_SERVICE_ACCOUNT` with the key
   JSON.
4. Once a deploy through the environment has succeeded, **delete** any
   repository-level `FIREBASE_SERVICE_ACCOUNT` (Settings → Secrets and variables
   → Actions). Until it is gone, the branch restriction can be walked around.

If the workflow runs before step 1, GitHub creates `production` itself, with no
branch restriction; deploys still work, but the gate is not there until steps
2–4 are done.

To set it up on a fork, make a deploy account that can do exactly what the
deploy does and nothing more (#82) — **not** the key under Firebase console →
Project settings → Service accounts. That one belongs to the Firebase Admin SDK
account, which can read and write every document and every user in the project:
far more than a key that lives in a CI secret should carry.

1. Google Cloud console, on the project → **IAM & Admin → Service accounts →
   Create service account**, named `github-deploy`.
2. Grant it three roles, and only these: **Firebase Hosting Admin**, **Firebase
   Rules Admin** and **Service Usage Consumer**. (The shared-car index is
   deployed by hand for this reason — see
   [The shared-car index](#the-shared-car-index-is-deployed-by-hand-66).)
3. On the new account → **Keys → Add key → JSON**.
4. Paste the whole JSON into the `FIREBASE_SERVICE_ACCOUNT` secret of the
   `production` environment (set up as in
   [The deploy environment](#the-deploy-environment-76)), add the four
   variables, and **delete the downloaded file** — it is a long-lived
   credential with deploy rights.

Hosting carries a **`predeploy` hook** that runs `npm run build`, so a deploy
from a laptop cannot ship a `dist/` that does not match the source. (CI strips
it and ships the artifact its own tests ran against — see above.) That guard is there for
the quiet failure rather than the loud one: a missing `dist/` stops the deploy
with an obvious error, but a *stale* one deploys perfectly happily and serves
last week's code with no sign that anything is wrong. The hook is scoped to the
hosting target, so `--only firestore:rules` stays fast and skips the build.

### The shared-car index is deployed by hand (#66)

A member's sync of a shared car reads with a query that needs a composite index
on `fillUps` (`vehicleId`, `syncedAt`), declared in `firestore.indexes.json`.
**Deploy it once**, from the repository folder on your own machine:

```bash
git checkout main && git pull                          # firestore.indexes.json arrived in #72
npm ci --prefix .github/firebase-cli                   # the pinned CLI — not installed by `npm ci`
.github/firebase-cli/node_modules/.bin/firebase login  # once per machine; opens a browser
.github/firebase-cli/node_modules/.bin/firebase deploy --only firestore:indexes --project <project-id>
```

The second line is the one that is easy to miss: the CLI has its own manifest in
`.github/firebase-cli/`, kept out of the app's dependencies, so the path in the
last line does not exist until it has been installed — the shell says `no such
file or directory`. The index then builds for a few minutes (Firebase console →
Firestore → Indexes) and is in use once it shows **Enabled**. If the deploy asks
whether to delete indexes that are not in the file, answer **No**: there should
be none, and one made by hand in the console would go.

It is not part of `deploy.yml` on purpose: deploying indexes needs the Cloud
Datastore Index Admin role, and the deploy account holds only Hosting Admin,
Rules Admin and Service Usage Consumer — see
[Workload Identity Federation](#workload-identity-federation-considered-and-deferred).
Granting a fourth role for a file that changes once in a long while is the
wrong trade. Nothing breaks without it: the read falls back to the whole car
(`withIndexFallback`), so sharing works from the first deploy, just with more
reads until the index exists. A member sees that in Settings, as part of the
sync's notice ("shared cars were read in full…", #89), so a missing index
does not go unnoticed. `toolchain.test.ts` keeps the index declared.

The rules tests are every `*.emulator.test.ts` file, run by `npm run test:rules`
(#97) — a Vitest project chosen by name, so a new emulator test file is picked
up by naming it, and `src/test/projects.test.ts` fails on one that imports the
emulator setup under any other name.

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
npm offered **firebase-tools 13.11.2** as the "fix" for ten of the sixteen,
two majors *backwards* from the version pinned at the time. It would report
success while making the deploy tool older. (The pinned version is in
`.github/firebase-cli/package.json`; docs never quote a pin, because a copy in
prose goes stale on the next bump — `src/test/pins.test.ts` refuses one.)

The real mitigation for a credential sitting next to that much code is not to
have a long-lived credential at all — see below.

### The check binaries are verified, and checkout keeps its token (#46)

Two gaps were left after #30. `src/test/workflows.test.ts` now enforces both.

**gitleaks and lychee are checked against a pinned SHA-256 before they are
extracted.** They used to be fetched by version and piped straight into `tar`.
A release asset can be replaced after the fact, and a trojaned gitleaks that
always exits 0 would turn the required secret scan into a green tick that
checks nothing. The hashes sit in `checks.yml` beside each version, as
`GITLEAKS_SHA256` and `LYCHEE_SHA256`, so changing a binary means a reviewed
diff. The step downloads to a file, runs `sha256sum --check --strict`, and only
then extracts, so a mismatch fails the job before anything runs.

**Bumping a version means bumping its hash.** Take it from the release's
published checksums where they exist. gitleaks ships
`gitleaks_<version>_checksums.txt`. Then confirm it against a download of your
own. Never take the hash from the same download step in CI, because a checksum
fetched alongside the tarball only proves the two were replaced together. A
release that publishes no checksum (lychee's, when it was first pinned) is
pinned to the hash of two downloads made hours apart that agreed. That can't
prove the first copy was genuine, but it does make any later change fail the
job.

**Knowing when to bump** (#99). These pins are environment variables, which
Dependabot cannot see. `.github/workflows/pins.yml` runs
`scripts/pins/check.ts` weekly and on demand: it reads each version from
`checks.yml`, asks GitHub for the tool's latest release, and goes red when a
pin is behind, listing both in the job summary. It only reports — the bump,
and its hash, are still made by hand as above.

**Every `actions/checkout` sets `persist-credentials: false`.** The default
leaves the `GITHUB_TOKEN` in `.git/config` for every later step. Those steps
include two `npm ci` installs, which run several hundred packages' lifecycle
scripts. Nothing after checkout needs git authentication. If a future step
does, give that one step a token explicitly rather than turning persistence
back on.

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
`if: always()`; and since #76 the key lives in a job that runs no app-tree npm
code at all, reachable only from `main` — see
[The deploy key never meets the build](#the-deploy-key-never-meets-the-build-76).
