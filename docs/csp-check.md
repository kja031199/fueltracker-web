# Checking the CSP against the live site

The Content-Security-Policy **is enforced** (issue #28). This page is how it
got there, and how to re-run the check the next time the policy changes —
which is not optional, for the reason the first run demonstrated.

## What the first run found

Two refusals, both on sign-in:

```
script-src-elem  https://apis.google.com/js/api.js?onload=__iframefcb285418
                   from assets/authProvider-*.js
script-src-elem  https://apis.google.com/_/scs/abc-static/_/js/k=gapi.lb…
                   from api.js:21
```

Firebase Auth injects `apis.google.com/js/api.js` to host its auth iframe, and
that file loads a second gapi chunk. Under `script-src 'self'` both were
refused — so **enforcing the policy without running this check would have
broken sign-in for every account on the next deploy**. `script-src` now names
`https://apis.google.com`, and nothing else off-origin.

Nothing else was refused: Firestore sync and the receipt scan were already
covered by `connect-src`.

## Why reasoning is not a substitute

A policy written without being able to load the deployed site is a guess. The
authoring environment cannot reach the deployed origin, the Firebase auth
domain or `cdn.jsdelivr.net`, and signing in needs a real Google account — so
the only honest evidence is a run in a real browser against the real site.

Report-only is what makes that safe: the browser evaluates the policy and
reports what it *would* have refused while refusing nothing, so a cascade stays
visible — the second refusal above was reported by a script that only ran
because the first one was not actually blocked.

## Re-running it

Do this whenever the policy changes, or when a change adds a request to a new
origin. It takes about five minutes.

**You need a desktop browser.** There is no console on a phone, and one of the
flows uses a file picker.

### 1. Arm the watcher

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

### 2. Run the five flows

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

### 3. Report

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

### 4. Disarm

```js
__fuelTrackerCsp.off()     // stops recording; the log is kept
__fuelTrackerCsp.clear()   // empties the log
```

## What to do with the answer

- **Nothing blocked** → nothing to do; the policy already covers what the app
  does.
- **Something blocked** → it needs fixing before it bites, which is usually one
  origin added to one directive in `firebase.json`. Now that the policy is
  enforced, a violation is not hypothetical: that request *is* being refused on
  the live site.

If a change is risky enough to want a report-only trial first, a report-only
header may be served **alongside** the enforced one — that is how a stricter
candidate gets tested. `src/ui/csp.test.ts` requires the enforcing header to be
present, so it cannot be quietly replaced by a report-only one again.

The obvious next tightening is dropping `'unsafe-inline'` from `style-src`,
which the app's inline `style` attributes currently require.
