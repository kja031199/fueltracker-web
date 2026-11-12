# Security headers and dependencies

What the browser is told to allow, the one third-party request the app makes,
and what the dependency audit says — including what was accepted rather than
fixed, and why. The access-control side is in [accounts.md](accounts.md) and
[sync.md](sync.md).

## Security headers, and what the app actually talks to

Hosting sets `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`,
a `Permissions-Policy` granting nothing (the app uses no camera, microphone or
geolocation — receipts arrive through a file input and GPS was dropped in the
port), and `Cross-Origin-Opener-Policy: same-origin-allow-popups`.

That last value is deliberate and worth knowing. The stricter `same-origin`
severs `window.opener` and **breaks `signInWithPopup`** — the single most likely
way a headers change takes this app down, and a failure that appears only on the
deployed site. There is a test asserting it is not that value, with the reason
in the assertion.

Each version of the Content-Security-Policy shipped as
**`Content-Security-Policy-Report-Only` first**, and is enforced now. Report-only,
the browser evaluates it and logs violations without blocking anything, so the
real flows could be exercised before it was enforced. A policy written without
being able to load the deployed site is a guess, and the failure mode of a wrong
guess is being locked out of your own app — so a future tightening should go the
same way.

It is **now enforced** (#28), and the check is why. Running
[csp-check.md](csp-check.md) against the deployed site refused two scripts, both
on the sign-in flow: Firebase Auth injects
`https://apis.google.com/js/api.js` to host its auth iframe, and that file then
loads a second gapi chunk from a generated path on the same origin. Enforcing
the policy without having found that would have broken sign-in for every
account on the next deploy — which is the entire argument for a report-only
period, made concrete.

`script-src` therefore names one off-origin source, `https://apis.google.com`,
and a test asserts it is the *only* one. That does mean Google can serve
arbitrary script to this page, which is already true of anybody using Firebase
Auth's popup flow: there is no supported way to run it without that script.

**It names exact hosts and allows no inline style** (#82). It used to allow
any `*.googleapis.com` — Cloud Storage among them, where anybody can host a
bucket, which would be an exfiltration channel if an injection ever appeared —
and any `*.firebaseapp.com`. Now `connect-src` names what the bundled Firebase
SDK actually contacts (`firestore`, `identitytoolkit` and
`securetoken.googleapis.com`), `frame-src` only this project's auth domain and
Google's account chooser, and `style-src` is `'self'` without
`'unsafe-inline'`: React's `style` props go through CSSOM, which CSP does not
govern, and the built page has no `style=` attribute (a test checks).
`script-src` is unchanged.

It went the same way as the first policy: served report-only beside the
enforced one, then a run of [csp-check.md](csp-check.md) on the live site —
sign-in, sync, a scan, an export and an offline reload, on 2026-11-10 — which
recorded **no violations at all**, and only then enforced.

The collector that produced the evidence lives in `src/ui/cspWatch.ts` and
records nothing until somebody arms it. It stays, because the next change to
the policy needs the same check: this one cannot be reasoned about from a
machine that cannot reach the deployed site.

`script-src` is `'self'` with no nonce or hash machinery, which is possible only
because the built page carries no inline script. Nothing in the build enforces
that — Vite happens to emit a single `<script src>` — so a test does, since the
alternative is discovering it in production.

### The receipt reader is served from this origin

Scanning a receipt used to fetch tesseract.js's worker, its wasm core and the
English language data from **`cdn.jsdelivr.net`** at scan time. `createWorker('eng')`
took no paths, and the defaults live inside the library. That worker ran **with
this origin's identity**, so it could read IndexedDB: the whole fuel log,
receipt photos included. Neither defence reached it. The CSP is an origin
allowlist and cannot tell a substituted file from the real one, and SRI never
sees `fetch` → `Worker`.

Since #17 those files are copied out of `node_modules` at build time into
`tesseract/<tesseract.js version>/`, so they are exactly what `package-lock.json`
pinned. Nothing is committed. `ocr.ts` passes all three paths, because a path
left out silently falls back to the CDN. Only the LSTM core variants are
shipped, and a device downloads one of the three.

- **Not precached.** That is about 7 MB (one ~3.9 MB core, 2.9 MB of language
  data, the worker), so installing the app costs what it did. The service
  worker caches them **on first scan**, after which scanning works offline,
  like everything else.
- **The worker is a real same-origin script** (`workerBlobURL: false`), so
  `worker-src` is `'self'` alone, with no `blob:` code that has no URL to audit.
- **`script-src` carries `'wasm-unsafe-eval'`**, which allows compiling
  WebAssembly and nothing else (no `eval`, no `new Function`).

**Scanning was broken on the live site from #39 to #17.** Enforcing the policy
refused both the core's `importScripts` from jsDelivr and the WebAssembly
compile, and it refused them *inside the worker*. A violation there is reported
to the worker, not the page, so the CSP watcher from #38 could not see it, and
the live check came back clean. `recognise()` then hung, because
`createWorker` never settles when the core aborts. It now gives up after
`READER_LOAD_TIMEOUT_MS` and says the reader is unavailable.

**#17 alone did not make scanning work.** Once the reader loaded, the first
real scan on a phone still failed: the app handed tesseract an `ImageBitmap`,
which its loader reads as zero bytes. Every throw was reported as the reader
being unavailable, so the message said to check the connection. The reader now
receives a JPEG `Blob`, and a failure says which part failed and why.

The OCR browser check in [development.md](development.md#the-ocr-browser-check)
is what found all of this, and it is what to run after touching the scanner or
the CSP.

Everything the app contacts is now same-origin apart from Google's own
endpoints for auth and Firestore.

## What the dependency audit says, and what was accepted

`npm ci` reports vulnerabilities. They have been assessed rather than ignored or
blanket-fixed, and the conclusion is recorded here so the number means something
to the next person who sees it.

**None of them reaches a browser.** That was checked, not assumed: grepping the
built chunks for `grpc-js`, `undici`, `source-map-js`, `serialize-javascript`,
`fast-uri` and `ejs` finds zero references in any of them.

Most are build tooling and test infrastructure — vite, vitest, workbox-build and
its rollup plugins — which run on a developer's machine and on CI runners, never
in anyone's browser.

**Four are in the production tree and all are one root cause**:
`@grpc/grpc-js`, reached through `@firebase/firestore`. They are **accepted**,
for three reasons together:

1. `grpc-js` is Firestore's **Node** transport. `@firebase/firestore`'s
   `exports` map sends the `browser` condition to a different entry that uses
   WebChannel over HTTPS, so it is not in the bundle at all.
2. Both advisories concern a gRPC **server** mishandling certificates and
   leaking handler errors to clients. This project runs no server. The only
   place grpc-js executes here is the rules test suite, in Node, against a local
   emulator.
3. **There is no fix to apply.** `npm audit` reports one as available, but
   `firebase` is already at the latest published version, so the "fix" resolves
   to a major change that would most plausibly *downgrade* it — making the app
   less current while reporting success. This is the concrete reason
   `npm audit fix --force` is not run here.

**@trap #19 — Do not run `npm audit fix`**, here or in `.github/firebase-cli/`:
it reports success while downgrading the package it claims to fix. None of the
findings reaches a browser, which was checked by grepping the built chunks, not
inferred from names.

Revisit when `firebase` publishes a release that moves off the affected
`@grpc/grpc-js`.

The four, for the record, so they are not re-triaged each time `npm audit
--omit=dev` shows them (#82): `@grpc/grpc-js` 1.9.16 against
[GHSA-m9gg-hp2v-232j](https://github.com/advisories/GHSA-m9gg-hp2v-232j) and
[GHSA-f596-whhp-79r4](https://github.com/advisories/GHSA-f596-whhp-79r4)
(affected `<= 1.13.5`), counted again through `@firebase/firestore`,
`@firebase/firestore-compat` and `firebase`. The built chunks were grepped
again: the only `grpc` in them is a Firestore setting's name,
`grpcFlowControlWindow`, not the library. **An `overrides` entry forcing
`@grpc/grpc-js >= 1.13.6` was considered and not added**: it would run
Firestore's Node transport — used here only by the rules tests — on a version
`@firebase/firestore` was never released against, to silence advisories about
a server this project does not run.

**Tried and rejected:** `vite-plugin-pwa` 1 → 2, on the theory that it would
pull a newer workbox and clear eight findings at once. It does not — 2.0.0
depends on the same `workbox-build` 7.4.1. A major version bump with no security
benefit is risk paid for nothing, so it was reverted.

## Known gaps, accepted for now (#82)

**No per-account quota.** The rules bound every *document* — its fields, its
text, a receipt to 700 KB — but not how *many* an account may write. An
allowlisted person, or a member of a shared car, can create as many fill-ups,
receipts or invitations as they like, and spend the owner's free-plan quota
doing it. The allowlist is what keeps this theoretical: everybody who can
write at all was let in by name. Invitations have deterministic ids
(`owner__car__email`), so the same invitation cannot be made twice, but one per
address is still unbounded. The next steps, if the allowlist ever grows past
people who are trusted: a cap enforced through deterministic ids (say, invites
per car), and App Check, which proves a request came from this app.

**`exifr` reads untrusted files on the main thread.** It parses the photo
somebody picks, to suggest a date, and has had no release in years. It is
loaded lazily, only for a photo, and only its `mini` build; what it parses
never reaches the database. The decompression-bomb gap this shares with image
decoding is written down in `src/ui/receiptImage.ts`. Replacing it, or moving
the parse into a worker so a hostile file can only stall that, is the change to
make when this code is next touched.
