# Checking the CSP before enforcing it

The Content-Security-Policy is served as **`Content-Security-Policy-Report-Only`**
(issue #28). The policy is written and tested, but report-only means the browser
reports violations instead of blocking them — so nothing it describes is
actually enforced, and with no reporting endpoint nothing is collected either.

Flipping it to enforcing is a one-line change. Doing that *safely* needs
somebody to run the real flows against the deployed site first, because a
policy that blocks sign-in breaks the app for everybody until a revert
deploys — and sign-in is the flow most likely to trip over `frame-src`,
`connect-src` or `Cross-Origin-Opener-Policy`.

That check cannot be automated from the authoring environment: the deployed
origin, the Firebase auth domain and `cdn.jsdelivr.net` are all unreachable
from it, and signing in needs a real Google account. So it is a person's five
minutes. This page is how to make those five minutes produce an exact answer.

**You need a desktop browser.** There is no console on a phone, and one of the
flows uses a file picker.

## 1. Arm the watcher

Open <https://fueltracker-899eb.web.app>, open DevTools (⌥⌘I on a Mac,
F12 elsewhere) and in the Console run:

```js
__fuelTrackerCsp.on()
```

Then **reload the page**. The watcher is installed by the app before anything
renders, so after the reload it is catching violations from the first byte —
including ones that happen during load, which a pasted snippet would miss.

It records nothing until armed, and it keeps what it records in `localStorage`,
so the findings survive the reloads that two of the flows involve.

## 2. Run the five flows

Nothing here needs to be done carefully — the point is to make the app do each
kind of work once.

1. **Sign out and back in with Google.** The popup is the single most likely
   thing to break under enforcement: it needs `frame-src` for the auth iframe,
   `connect-src` for the token exchange, and a `Cross-Origin-Opener-Policy`
   that does not sever `window.opener`.
2. **Add a fill-up, then Settings → Sync now.** Exercises Firestore's
   WebChannel connection against `connect-src`.
3. **Scan a receipt** (Fill-ups → add → the photo button). Fetches the OCR
   engine and language data from `cdn.jsdelivr.net` and runs it in a worker
   created from a blob — `connect-src` and `worker-src blob:`.
4. **Save a backup** (Settings → Export JSON, or the banner if it is showing).
   A blob download.
5. **Reload with the network off** (DevTools → Network → Offline, then reload).
   The service worker serves the app; this is where `manifest-src` and the
   precache show up.

## 3. Report

```js
__fuelTrackerCsp.report()
```

Copy the output. It is either:

```
No CSP violations recorded. (If the watcher was armed and the flows were run, the policy is clean.)
```

or a list like:

```
CSP violations: 2 distinct, 7 event(s).
  connect-src  ×6
      blocked: https://example.com/thing
  style-src  ×1
      blocked: inline
      sample: color: red
```

Repeats of the same directive-and-target are counted rather than listed, so a
request that fires in a loop does not bury the one that matters.

## 4. Disarm

```js
__fuelTrackerCsp.off()     // stops recording; the log is kept
__fuelTrackerCsp.clear()   // empties the log
```

## What happens with the answer

- **Nothing blocked** → the header flips from
  `Content-Security-Policy-Report-Only` to `Content-Security-Policy` in
  `firebase.json`, and `src/ui/csp.test.ts` is changed to assert the
  *enforcing* header so a revert to report-only fails CI.
- **Something blocked** → it gets fixed first, which is usually one origin
  added to one directive. A violation on a flow that still *worked* is exactly
  what report-only is for: it would have broken once enforced.

The same three lines re-run this check the next time the policy gains an
origin, which is why the watcher stays in the app rather than being deleted
once #28 closes.
