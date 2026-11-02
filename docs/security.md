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

The Content-Security-Policy ships as **`Content-Security-Policy-Report-Only`
first**. The browser evaluates it and logs violations without blocking
anything, so the real flows can be exercised before it is enforced. A policy
written without being able to load the deployed site is a guess, and the
failure mode of a wrong guess is being locked out of your own app.

`script-src` is `'self'` with no nonce or hash machinery, which is possible only
because the built page carries no inline script. Nothing in the build enforces
that — Vite happens to emit a single `<script src>` — so a test does, since the
alternative is discovering it in production.

### The one third-party request

Scanning a receipt fetches tesseract.js's worker, its wasm core and the English
language data from **`cdn.jsdelivr.net`**, at scan time. `createWorker('eng')`
takes no paths, and those defaults live inside the library, so nothing in this
repository's own source mentions the domain. It means jsdelivr learns that
somebody started a scan — not the image, not the result — and that scanning
fails where that CDN is blocked.

Everything else is same-origin apart from Google's own endpoints for auth and
Firestore. Self-hosting the tesseract assets would remove the dependency and
costs several megabytes of hosting transfer per scan; it has not been done, and
this paragraph is the honest version of that choice.

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

Revisit when `firebase` publishes a release that moves off the affected
`@grpc/grpc-js`.

**Tried and rejected:** `vite-plugin-pwa` 1 → 2, on the theory that it would
pull a newer workbox and clear eight findings at once. It does not — 2.0.0
depends on the same `workbox-build` 7.4.1. A major version bump with no security
benefit is risk paid for nothing, so it was reverted.
