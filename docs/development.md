# Working on this

Running it locally, and the checks every pull request goes through. If you are
an AI assistant working in this repository, read
[`CLAUDE.md`](../CLAUDE.md) as well — it holds the invariants and the traps.

## Development

```bash
npm install
npm run dev        # vite dev server
npm test           # vitest: the unit and DOM tests, which need nothing but Node
npm run test:build # build, then test the built site in dist/
npm run test:rules # the rules tests, on the Firestore emulator (see below)
npm run lint       # oxlint: the two React hooks rules, nothing else
npm run typecheck  # tsc -b: the app and the tests, as two projects
npm run build      # typecheck, then a production build
```

The tests are four Vitest projects, and a file's **name** says which one it
is in (#97):

| Project | Files | Run with | Needs |
|---|---|---|---|
| `unit` | every other `*.test.ts`, on Node | `npm test` | nothing but Node |
| `dom` | every `*.test.tsx`, and `*.dom.test.ts`, on jsdom | `npm test` | nothing but Node |
| `build` | `*.build.test.ts` — they read `dist/` | `npm run test:build` | a build, which the script makes first |
| `rules` | `*.emulator.test.ts` | `npm run test:rules` | the Firestore emulator, which the script starts; install its CLI once with `npm ci --prefix .github/firebase-cli` |

The `build` and `rules` projects **fail** without what they need, with a
message naming the script, rather than skipping: they used to skip in every
normal run, and a test that always skips is barely different from one that was
never written. Name a new test for what it needs — `src/test/projects.test.ts`
fails on a file that reads `dist/` or imports `src/test/emulator.ts` without
the matching name, and on one that runs in no project or in two. A single file
runs on its own as usual: `npx vitest run src/ui/App.test.tsx`.

The project chooses the environment: component tests get jsdom from `dom`,
and the domain and storage suites stay on Node in `unit`, which starts faster
and needs nothing a browser provides — the cost of a DOM is paid only where it
buys something. No file sets its own with a `@vitest-environment` docblock.

Each test starts clean without asking: the config restores spies, stubbed
globals and stubbed env before every test (`restoreMocks`, `unstubGlobals`,
`unstubEnvs`), and Testing Library unmounts after every test.
`src/test/isolation.test.tsx` proves it, and `projects.test.ts` refuses the
hand-written versions — and a write to a prototype, which nothing restores;
spy on it instead.

The type checker has two projects (`tsconfig.app.json`, `tsconfig.test.json`),
so app code cannot use test globals or Node's `process`.

## Automated checks

Four checks run on every pull request and every push to `main`, and all four
are required. None of them skip, so each always reports a status — which is
what makes requiring them safe: a check that sometimes reports nothing cannot
be required, because a pull request would wait forever for a result that never
comes.

| Check | What fails it |
|---|---|
| **Typecheck, test & build** | A type error, a React hooks lint finding, a ported assertion no longer holding, or an app that no longer builds |
| **Firestore security rules** | The rules letting one account read another, or an allowlist still holding a placeholder |
| **Secret scan** (gitleaks) | A credential-shaped string in **any commit**, not just the diff |
| **Docs links** (lychee) | A broken relative link or `#heading-anchor` in Markdown |

The rules check runs the real emulator against the real `firestore.rules`, with
the pinned Firebase CLI — the same one the deploy uses, so a broken pin fails a
required check rather than a deploy.

The link check is `--offline` on purpose: it validates on-disk targets and
anchors, and skips external URLs so a third party's server being down can never
stand between a correct change and `main`.

`npm ci` is used rather than `npm install` — it installs exactly what the
lockfile pins and fails if the lockfile and manifest disagree, instead of
silently resolving a different tree.

## Release notes

[`RELEASE_NOTES.md`](../RELEASE_NOTES.md) records what each update changed,
newest first, under the date it went live (every merge to `main` deploys, so
that is the merge date, UTC). It starts at the fill-up links (#74); nothing
earlier was back-filled.

**Every pull request that closes an issue adds a note for it.** An entry is a
list item under the day's `## YYYY-MM-DD` heading:

```md
- **What changed, as someone using the app would see it.** A sentence or two more.
  *Technical:* what changed in the code, briefly.
  [#88](https://github.com/kja031199/fueltracker-web/issues/88) · [PR #112](https://github.com/kja031199/fueltracker-web/pull/112)
```

A change nobody using the app will notice says so in the first sentence ("No
change you'll see: …"). A pull request learns its own number only once it is
opened, so the PR link usually arrives in a second push. One entry may cover
several issues.

**The "Release notes" check** (`.github/workflows/release-notes.yml`) enforces
it. It reads which issues the pull request closes — GitHub's closing keywords in
the description (`Closes #12`, `fixes: #3`), and the `(#N)` this repository puts
in titles — and fails unless the lines the pull request **adds** to
`RELEASE_NOTES.md` name each of them. Mentions ("see #4", "part of #101") and
other repositories' issues (`owner/repo#9`) are not claims. A pull request that
closes nothing passes, so the check always reports a status and is safe to
require. It also runs when the title or description is edited.

The title and description are written by whoever opened the pull request, so
they reach `scripts/release-notes/check.ts` as environment variables and are
never written into the workflow's command; `workflows.test.ts` fails if any
workflow puts a pull request's text inside a `run:`. The checker uses Node
built-ins only (`node --experimental-strip-types`), and `releaseNotes.test.ts`
tests both it and the shape of `RELEASE_NOTES.md`: real dates, newest first, a
user sentence, a *Technical* line, and links whose number matches where they
point.

It is not one of the four required checks until it is added to the branch
protection rules on `main` (Settings → Branches), which is a manual step.

## The OCR browser check

Receipt scanning runs WebAssembly in a worker, and **a CSP violation inside a
worker is reported to the worker, not the page**. Unit tests and the CSP
watcher both miss it. From #39 to #17 the live site's reader was refused on
every scan, and nothing noticed. So scanning has a real-browser check:

```bash
npm i --no-save playwright && npx playwright install chromium   # once, if not installed
node scripts/ocr-check/check.mjs
```

It builds the app with a probe page added (`OCR_PROBE=1`, into a temporary
directory; the probe never ships), serves it with **the headers from
`firebase.json`**, and drives Chromium through four scenarios:

1. The production CSP reads a receipt drawn on a canvas.
2. No request leaves this origin. Anything that tries is aborted, so a CDN
   fallback fails the scan rather than hiding in a count.
3. After one scan with the service worker installed, the scan works
   **offline**.
4. **Negative control:** the same CSP without `'wasm-unsafe-eval'` must fail,
   and fail *cleanly*, with "unavailable" rather than a hang. This proves the
   check can fail, and it reproduces the live site's failure exactly.

5. **The app's real import pipeline** reads a receipt. A drawn receipt,
   encoded as a JPEG `File`, goes through `importReceiptPhoto` → `prepareImage`
   → `recognise` → `parseReceipt`, and the suggested gallons and price must be
   exactly right. Scenarios 1–4 call `recognise` with a `Blob` directly, and so
   passed while every real scan failed: the pipeline handed tesseract an
   `ImageBitmap`, which it reads as zero bytes. This scenario is the one that
   would have caught it.
6. **Optional, local only:** `--photo <path>` runs a real receipt photo
   through the same pipeline and prints what it offers. It passes when values
   are offered, and **whether they are right is for you to judge** with the
   receipt in hand. `OCR_DEBUG=1` also prints the recognised lines, which is
   how to diagnose the parser. **Never commit a real receipt**: card digits,
   account and transaction numbers.

The probe is type-checked with the app (`tsconfig.app.json`), so a module
it imports cannot move without `npm run typecheck` saying so. It once did,
silently, and the check could not even build for a while (#90).

It takes a couple of minutes, mostly scenario 4 waiting out the load bound. It
is not in CI, by decision: CI covers the same ground through `csp.build.test.ts`,
`ocr.test.ts` and `ocrAssets.build.test.ts`. **Run it after changing the scanner, the
CSP or the service worker.**

## Mutation testing

Tests are checked by breaking the thing they guard on purpose and confirming
the suite goes red — a test that cannot fail is decoration, and a security-rules
test that cannot fail is worse, because it reads like proof. Required for
`firestore.rules`, account separation, and anything guarding the data boundary;
expected for any change whose tests could pass without catching anything.

Every mutation is **recorded as data** in `scripts/mutations/sets/` (#98), one
file per piece of work, and can be run again by anyone:

```bash
npm run mutate                 # every mutation, inside one Firestore emulator
npm run mutate -- 079 sharing  # only the sets or mutations those words name
npm run mutate:check           # no tests: does every mutation still apply?
```

A mutation names a file, the exact text to replace (which must occur once —
or no `from` at all, to replace the whole file, as the identity-only and
wide-open rules do), what to put there instead, and optionally the tests that
should catch it. Without `tests`, a rules mutation runs the `rules` project and
anything else the main suite. Each run stops at the first failing test
(`--bail 1`), so the runner reports **killed or not**, never counts: a count
changes every time someone adds a test, and a recorded number nobody can
re-derive is what this replaced.

```json
{
  "title": "#79 Merge stamp",
  "mutations": [
    {
      "name": "future bound removed",
      "file": "firestore.rules",
      "from": "          && request.resource.data.updatedAt <= request.time.toMillis() + maxAheadMs()\n",
      "to": ""
    }
  ]
}
```

**Recording one in a pull request:** add it to the set for that piece of work
(a new file, `NNN-topic.json`, numbered by the issue), run
`npm run mutate -- <its name>`, and see it killed. Every mutation that
survived and was **equivalent** — no input could tell the two programs apart —
is kept with `survives` and the reason; the runner reports it without failing.
One that survived and was not equivalent is a missing test: write it.

**What a kill has to mean.** Three things made "killed" lie while this was
built, and the runner now refuses each:

- *The record's own check in the run.* `src/test/mutations.test.ts` fails for
  every applied mutation (the mutated file no longer holds its `from`), so a
  run of the whole suite "killed" everything. Every run excludes it.
- *A dead emulator.* The emulator watched `firestore.rules` and died reloading
  it on the first rules mutation; every rules mutation after it then "failed"
  in a second, against nothing. The emulator now starts from
  `scripts/mutations/firebase.json`, which names no rules file (the tests load
  the rules themselves), and the runner checks it answers before and after
  every mutation, stopping the run rather than counting a guess. A control —
  a comment changed in the rules — survives the full rules suite.
- *A test file that no longer exists.* Renamed files left in a `tests` list
  quietly stopped running, and a list of nothing but missing files would make
  vitest exit non-zero with nothing run. A missing test path is a stale record.

A run that is killed outright (no `finally`, no signal handler) leaves the
original of the file it was changing in `scripts/mutations/.restore/`
(gitignored); the next run puts it back before anything else.

**Two runs keep the record honest:**

- **On every pull request**, `src/test/mutations.test.ts` (in `npm test`)
  checks that each recorded mutation still applies — its text still occurs
  exactly once. A change that moves code a mutation breaks fails there, at
  once, and the mutation moves with the code. This takes a second.
- **Weekly, and on demand**, `.github/workflows/mutation.yml` runs them all
  (Actions → Mutation testing → Run workflow). A survivor fails that run and is
  listed in its job summary. Not a required check: it takes most of an hour.

**Where the record came from.** The sets for #77 onward were converted from
the scripts each pull request used, re-pointed where the code had since moved,
and the handful whose code is gone (the vehicle comparison deleted in #96, two
file-rename tricks the format cannot express) were dropped. Before #77 only a
table of hand counts was kept, with nothing to re-run; from it, the rules
foundations (identity-only and wide-open rules, the allowlist and per-uid
scoping in `owner()`, sharing, `syncedAt`) and the data-boundary rows
(per-account databases and preference keys, tombstones, ids, the CSV guard)
were rebuilt as `000-rules-foundations.json` and `000-data-boundary.json`. The
other early rows — the OCR, toolchain and early UI ones — had no data and were
retired; the table is in git history before #98.

The first set is the one to understand before touching `firestore.rules`:
identity-only rules — the version that asked "is this your tree?" and nothing
else — and wide-open rules must both fail the rules suite.
