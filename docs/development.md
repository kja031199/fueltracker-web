# Working on this

Running it locally, and the checks every pull request goes through. If you are
an AI assistant working in this repository, read
[`CLAUDE.md`](../CLAUDE.md) as well — it holds the invariants and the traps.

## Development

```bash
npm install
npm run dev        # vite dev server
npm test           # vitest
npm run lint       # oxlint: the two React hooks rules, nothing else
npm run typecheck  # tsc --noEmit
npm run build      # typecheck, then a production build
```

Component tests opt into a DOM per file with a `@vitest-environment jsdom`
docblock. The domain and storage suites stay on the node environment, which
starts faster and needs nothing a browser provides — the cost of a DOM is paid
only where it buys something.

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

It takes a couple of minutes, mostly scenario 4 waiting out the load bound. It
is not in CI, by decision: CI covers the same ground through `csp.test.ts`,
`ocr.test.ts` and `ocrAssets.test.ts`. **Run it after changing the scanner, the
CSP or the service worker.**

## Mutation testing

Tests are checked by breaking the thing they guard on purpose and confirming
the suite goes red — a test that cannot fail is decoration, and a security-rules
test that cannot fail is worse, because it reads like proof. Required for
`firestore.rules`, account separation, and anything guarding the data boundary.

Recorded so a regression in the tests themselves is visible:

| Mutation | Fails |
|---|---|
| Identity-only rules / wide-open rules | 13 / 20 |
| Sign-in allowlist dropped from `owner()` | 2 |
| Per-uid scoping dropped from `owner()` | 2 |
| One shared database for all accounts | 6 |
| Tombstone back to `{ ...row, deletedAt }` | 14 |
| Tombstone keeping only its receipt | 7 |
| `isScrubbed` always true / comparing `updatedAt` | 7 / 2 |
| Tombstone exception dropped from `preserveLocalReceipts` | 1 |
| `isStorableId` reduced to a non-empty check | 14 |
| Id check dropped from validation / imports / push | 6 / 2 / 3 |
| Id check **over**-refusing (any dot or underscore) | 4 |
| CSV formula guard removed / made irreversible | 11 / 2 |
| Idle timeout: a naive first implementation | 13 of 34 |
| Backup reminder dismissing permanently instead of snoozing | 2 |
| An action unpinned / its version comment dropped | 2 / 1 |
| A binary's checksum check deleted / moved after `tar` / its pinned hash removed | 2 / 1 / 1 |
| One `persist-credentials: false` deleted / set to `true` | 1 / 1 |
| Text: draft gate / `addVehicle` / import left unbounded | 1 / 1 / 1 |
| Text: a push refusal reported as `refused` again / sync skipping the repair / repair keeping the old `updatedAt` | 2 / 1 / 1 |
| Text: push backstop ignoring text / unstorable `vehicleId` accepted on import / sent on push | 1 / 1 / 1 |
| Text: `boundText` splitting an emoji / a client limit drifting from the rules / `maxLength` removed | 1 / 2 / 1 |
| Date window: chain over windowed rows / dashboard filtering first (both the #51 bug) | 5 / 1 |
| Sync: always a full read / push everything / one shared mark / mark moving backwards | 2 / 5 / 2 / 1 |
| Sync: unstamped read leaving the mark null / full read not rebuilding `known` / clock observing only pulled rows | 1 / 1 / 1 |
| Sync: cursor version ignored / no weekly reconcile / full reads timed by the merge clock / junk cursor accepted | 1 / 1 / 1 / 1 |
| Sync timing: focus not throttled / saves not coalesced / a save mid-sync dropped / App not syncing after a save | 2 / 1 / 2 / 1 |
| One decoder: file vehicles / fill-ups / submissions bypassing it / CSV refusals unreported | 5 / 12 / 2 / 3 |
| One decoder: file receipts unbounded / dropped / a string flag read as true / garbled `deletedAt` accepted / domain importing data | 1 / 4 / 1 / 1 / 1 |
| Local reads: fill-ups / count / vehicle removal back to a whole-table read | 3 / 2 / 1 |
| Local reads: summaries keeping photo bytes / `hasReceipt` always false / edit form started from a list row | 1 / 1 / 1 |
| Local reads: no re-read after a reload / `deletedAt` index missing / Dexie count including tombstones | 2 / 3 / 3 |
| Local reads: per-vehicle read including tombstones (Dexie / in memory) | 1 / 5 |
| OCR: `workerPath` / `langPath` left out (CDN default) / blob worker again / no load timeout / late worker left running | 1 / 1 / 1 / 2 / 1 |
| OCR CSP: without `'wasm-unsafe-eval'` / with full `'unsafe-eval'` / CDN back / `blob:` workers back | 1 / 1 / 1 / 1 |
| OCR build: reader precached / route back to a closure / wrong core variant / runtime route removed | 1 / 1 / 1 / 2 |
| OCR input: reader handed the bitmap again / a read failure reported as unavailable / load detail dropped | 1 / 1 / 3 |
| OCR input: detail not shown / detail unbounded / a failed encode of the reading copy ignored | 1 / 1 / 1 |
| Fuel line: rung removed / labels winning over it / first of two disagreeing lines trusted | 7 / 6 / 1 |
| Fuel line: two-decimal price / whole-number quantity / range check / lookbehind / lookahead dropped | 1 / 1 / 1 / 1 / 1 |
| Sharing: email not lowercased / two @ accepted / accept without the address / member writes another car / forges enteredBy / scope keeps submissions | 6 / 2 / 1 / 1 / 2 / 1 |
| Sharing sync: own sync copies shared cars / share sync pushes everything / removed car kept / left-elsewhere car kept / deleted car kept / ledger saved empty / ledger keeps ended shares | 4 / 4 / 4 / 3 / 1 / 5 / 1 |
| Ties: edit beats deletion / local winner not re-stamped / no tie-break on merge | 3 / 3 / 3 |
| Sharing store: forget leaves tombstones / edit loses who entered it / tombstone drops it / enteredBy length unchecked / shared car offered Delete | 3 / 3 / 3 / 2 / 4 |
| Sharing rules (emulator): any allowlisted account reads any fill-up / joining without an invitation / member changes who entered it | 3 / 2 / 1 |
| Missed fill-up hint: mean not median / at-least not more-than / two gaps enough / own reading not excluded / kept after ticking / beside the backwards warning | 1 / 2 / 1 / 1 / 1 / 1 |
| Admin idle timeout: bad text / unset failing open / decimals accepted / no trim / overflow not held to a day / `>` at the boundary | 17 / 8 / 2 / 1 / 1 / 1 |
| Admin idle timeout: module hard-coding 30 / App ignoring it / armed while signed out / legacy setting kept / legacy "off" honoured | 1 / 1 / 1 / 1 / 1 |
| Admin idle timeout: Settings showing a fixed 30 / notice saying the reader chose it / deploy not passing the Variable | 1 / 1 / 1 |
| Fuel log: an action bypassing `written` (remove fill-up / import) / no sync after writes / no refresh / a failed write syncing | 1 / 1 / 6 / 5 / 1 |
| Fuel log: opening a vanished fill-up syncing / not refreshing / a screen importing the store again | 1 / 1 / 1 |
| Tabs: hash ignored on load / choosing replaces history / no `hashchange` / correction pushing an entry / no correction | 2 / 1 / 2 / 1 / 3 |
| Tabs: `parseTab` case-insensitive / prefix-matching / without the `#/` check | 1 / 1 / 1 |
| Links (#3): length cap / base64url alphabet / fatal UTF-8 / version / kind / id checks / request car check | 3 / 1 / 1 / 3 / 4 / 2 / 3 |
| Links: future date / ancient date / no clock slack / full-tank type / draft gate skipped / junk `submittedAt` kept | 1 / 1 / 1 / 1 / 6 / 3 |
| Links: text unbounded in / out / a photo carried / "missed" carried | 1 / 1 / 1 / 1 |
| Links: duplicates queued / tombstones forgotten / missing car queued / deleted car approved / sender's name unbounded | 4 / 2 / 2 / 1 / 1 |
| Links: route corrected to the dashboard / multi-segment / case-insensitive / leaving adds history / onboarding first | 1 / 2 / 1 / 2 / 12 |
| Links: request on every car / shared car received / ledger not consulted / no retry after a sync | 6 / 1 / 1 / 1 |
| Links: Approve on a deleted car / refusal not shown / submitter's log written / one id for every visit / name not pre-filled / link form keeping the photo / keeping storage limits | 1 / 1 / 1 / 1 / 2 / 1 / 1 |
| Toolchain: `@types/react` / `@types/react-dom` back to 18 / lint script removed / description reverted | 1 / 1 / 1 / 1 |
| Toolchain: exhaustive-deps off / only a warning / a rule category on wholesale / `vite.config.ts` out of `include` | 1 / 1 / 1 / 1 |
| Database: the `'fueltracker'` default name restored (caught by `tsc`, an unused `@ts-expect-error`) | 1 |
| Account state: key ignoring the uid / unscoped value kept / adopted / empty uid / unbounded uid | 21 / 5 / 6 / 2 / 1 |
| Account state: hook ignoring a uid change / setter keeping the first uid / App passing no uid for sync time / backup / onboarding | 1 / 1 / 1 / 5 / 9 |
| Preferences: storage access unguarded / failed write reported stored / decoder throw uncaught / empty text read as 0 / browser keys renamed | 1 / 1 / 23 / 1 / 9 |
| Storage boundary: detector reading comments as uses | 2 |
| Sync (emulator): rules accepting any `syncedAt` / push unstamped / records carrying it / remote ignoring the cursor | 1 / 4 / 1 / 2 |
| Date window: segments not windowed / boundary exclusive / invalid date as a window | 4 / 6 / 1 |
| Date window: no anchor / anchor without odometer guard / cost per mile ignoring it / intervals ignoring it / suspect norm from the window | 1 / 1 / 1 / 1 / 1 |
| Sign-in adopting the legacy database (the #44 behaviour) | 3 |
| Sign-in copying legacy rows but keeping the original / deleting it uncopied | 2 / 2 |
| Sign-in merely opening the legacy database / opening the wrong account's | 1 / 1 |
| Dev guard: `dev` signal / hostname signal dropped | 1 / 8 |
| Dev guard: always refusing / id not normalised / constant wrong | 2 / 1 / 1 |
| Local-host check: unanchored `127.` / `includes('localhost')` / no lower-casing / `[::1]` dropped | 1 / 2 / 1 / 2 |
| Page and manifest descriptions claiming "no account, no server" again | 1 / 1 |
| Deploy key (#76): no environment / no `needs` / CLI without `--ignore-scripts` / `npm run build` in the key job / `--config` dropped / predeploy kept | 1 / 1 / 1 / 1 / 1 / 1 |
| Deploy key: secret read in the build job / key written before `npm ci` / before the download | 8 / 1 / 1 |
| Share ledger (#77): unreadable read as empty / failing closed only with the list unreachable too / reported as a refusal | 4 / 3 / 2 |
| Share ledger: no save before pulling / that save's failure ignored / ended shares dropped before they are forgotten | 2 / 1 / 1 |
| Id clash (#78): rules (emulator) / in-memory world / Accept unchecked / shown as a network error / no clash detection / held shares flagged too | 2 / 2 / 1 / 1 / 4 / 15 |
| Id clash: recorded in the ledger / clashed shares synced / store ignoring tombstones / clash not reported | 1 / 3 / 1 / 1 |
| Stale edit (#83): deleted fill-up not refused / written back / car gone not refused / saved under another car | 4 / 4 / 1 / 2 |
| Stale edit: no refresh after it / refusal swallowed / generic message / form closes on it | 1 / 2 / 1 / 2 |
| Local reads (#87): export two reads per table / merge reading every row / push re-reading the device / a view per remote | 8 / 7 / 7 / 5 |
| Local reads: no refresh after the merge / after a re-stamp / after the repair / repair never run / car lookup stale | 1 / 1 / 2 / 2 / 1 |
| Local reads: Dexie `listDeleted` returning live rows / `getMany` hiding tombstones (memory / Dexie) / forget missing deleted rows | 3 / 12 / 1 / 4 |
| Merge stamp (#79): future bound removed / set to a day / no-going-backwards removed / equal stamp refused | 3 / 2 / 3 / 3 |
| Merge stamp: `finite` reduced to `is number` / invite date unchecked / in-memory far-future / backwards / client bound at the adoption cap | 10 / 1 / 1 / 1 / 2 |
| Revoking (#80): join leaving the invitation / joining a deleted car / `memberOf` ignoring deletion (all emulator) / accept in three writes | 1 / 1 / 2 / 5 |
| Revoking: `removeMember` keeping the invitation / `endSharing` doing nothing / delete not ending sharing / in-memory: deletion ignored / deleted car accepted / invitation kept | 1 / 1 / 1 / 1 / 1 / 1 |
| Shared-car results (#84): refused upload filed as unreachable / refused upload forgetting the car / outcomes dropped / notice ignoring shared cars / refusal not said | 2 / 2 / 2 / 1 / 1 |
| Transactions (#85): no transaction from `dexieRepositories` / work on `db` tables rather than the transaction's / account store without it / Dexie `putMany` dropping a single row | 7 / 2 / 1 / 2 |
| Transactions: car delete leaving submissions / car delete, forget, import, approve, receive, edit each not atomic / duplicate in a file kept by order / repair from the rows sync read | 3 / 1, 1, 3, 1, 1, 1 / 1 / 2 |
| Validation (#86): newer backup rows imported / this version counted as newer / skipped silently / "1 rows" | 3 / 12 / 3 / 2 |
| Validation: ledger ids unchecked / ledger names unbounded / tombstone keeping `date` / new deletion time / submission tombstones refused | 1 / 1 / 3 / 2 / 2 |
| Validation: invite owner / car name, member name, read-back invite, read-back member unbounded (all emulator) | 1 / 1 / 1 / 1 / 1 |
| Renders (#88): app data a fresh object / fuel log rebuilt on sync status / same sharing lists replaced / shell reading sync status | 3 / 3 / 1 / 1 |
| Renders: a stale load shown over a newer one / a selection shown before its fill-ups / formatter cache off / cache key ignoring options / odometer check measuring from an equal reading | 1 / 1 / 2 / 14 / 2 |
| Release notes: keywords only `closes` / title `(#N)` ignored / removed lines counted / `#12` matching `#123` / mentions counted / no word boundary / body interpolated into `run:` / `edited` not a trigger | 1 / 1 / 2 / 3 / 1 / 1 / 2 / 1 |
| Release notes, the file: dates out of order / an impossible date / no *Technical* line / a link to the wrong number / an issue link labelled PR / an "Unreleased" heading / no user sentence | 1 / 1 / 1 / 1 / 1 / 2 / 1 |
| Sharing reads (#89): memberships not handed to the screens / the view reading them again / reload after every share sync / names never cached / new uids ignored / a nobody's uid re-asked | 1 / 1 / 1 / 1 / 1 / 1 |
| Sharing reads: index note removed / `indexMissing` not carried / fallback not told / invites not narrowed in memory / in Firestore (emulator) / `syncAll` handing back nothing | 1 / 2 / 1 / 1 / 2 / 2 |
| Rules upkeep (#92): any one of the 26 bounds in `label()`/`sized()` raised by one / receipt bound / stamp bound / an inline `.size()` back / a fill-up key dropped / a junk vehicle key / `enteredBy` made required / `exists()` before `get()` | 1 each / 1 / 1 / 2 / 1 / 1 / 1 / 1 |
| Rules upkeep, emulator: the users document readable / `liveCar` ignoring deletion | 1 / 4 |

Equivalent, and kept as a backstop: `shape()` without its `hasAll`. Every
required field is also read by a clause of its own, and reading a missing field
is an error, which refuses the write; `hasAll` would start to matter only for a
field no other clause mentions.

Equivalent, and kept for parity: the repair skipping tombstones. A tombstone
carries no text, so there is nothing for it to shorten.

Survives, and equivalent: dropping the array check from the link decoder — a
JSON array cannot carry the version field, so it is refused as damaged either
way.

The first row is the one to understand before touching `firestore.rules`:
identity-only rules — the version that asked "is this your tree?" and nothing
else — still pass 13 fewer assertions than the current file, and wide-open
rules pass 20 fewer.
