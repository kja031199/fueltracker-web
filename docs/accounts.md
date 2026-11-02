# Accounts and sessions

Who can sign in, what signing in gets you, how a session ends, and why local
storage is separated per account. The data side — how rows move between a
device and the account — is in [sync.md](sync.md).

## Signing in

Google sign-in, via Firebase Auth, and it is **required**. That reverses this
project's founding local-first decision, deliberately and at the owner's
request, and the cost is worth stating: a brand-new device with no network
cannot get in. After the first sign-in on a device it works fully offline,
because the session is persisted in IndexedDB and restored without a network
round-trip — which is also why the Firebase chunks are precached by the service
worker rather than excluded for their size. Without them an offline reload could
not restore the session, and the app would not open at all.

Settings → Account shows **your account id** — the uid Firebase knows you by —
with a button to copy it. It is there because it is the identifier that grants
access to a deployment, and the only other place to find it is the Firebase
console, which the person who needs to read it usually cannot open. It comes
from Auth rather than Firestore, so it stays readable even for somebody whose
data reads are all being refused.

Only non-sensitive profile scopes are requested (email and display name), so
there is no OAuth verification screen and no seven-day token expiry. That ruled
out the simpler-looking alternative of keeping one JSON file in the user's Google
Drive: `drive.appdata` is a sensitive scope, which caps an unverified app at 100
lifetime users and expires its tokens weekly.

## Who can sign in

Signing in with Google is not the same as being allowed in, and until #27 this
project treated it as if it were. Any Google account on earth could sign in and
write data under its own uid: `firestore.rules` confined a stranger to their own
tree, and then let them fill it — on this project's daily write quota, inside
its 1 GiB, and invisible to the owner, because nobody can read anybody else's
tree. Being bounded to your own corner is not the same as being admitted.

So `firestore.rules` now carries an **allowlist of uids**, and every read and
write is gated on it as well as on owning the path. An account that is not on
the list is refused everywhere, including in its own tree.

Being on the list grants **a tree of your own, not a look at anybody else's**.
Two allowed accounts are as separate as an allowed account and a stranger: the
same `request.auth.uid == uid` check scopes both. The rules suite asserts that
directly whenever the list holds more than one entry.

Uids rather than email addresses, for three reasons:

- A uid is opaque, so a public repository stays free of anybody's personal
  data. An allowlist of email addresses would publish other people's.
- A list literal costs nothing to evaluate. Looking an allowlist up with
  `exists()` would add a billed read to *every* request, which is a strange
  thing to spend on a rule about quota.
- A list a reader can see is a list a reviewer can check.

The cost is real and worth stating: **a uid does not exist until its owner has
signed in once.** To add somebody:

1. They sign in. Instead of the app they get a screen saying **this account
   does not have access**, with their account id and a button to copy it. The
   app deliberately stays closed: the first-run flow it used to show promises
   that a fuel log is kept in your Google account, which for them would be
   false, and they would be logging fill-ups that could never leave the device
   (#41).
2. They send you the id. It is the same value the rules compare against, and it
   is readable even though every data read is being refused, because it comes
   from Auth rather than Firestore. (Firebase console → Authentication → Users
   shows the same string in the **User UID** column, for an owner who would
   rather look than ask.)
3. Add it to the `allowed()` list in `firestore.rules`, in a pull request.
4. Merging deploys the rules (rules first, then hosting — see *Deploying*).
   Tell them when it is done and they press **Try again** on that same screen —
   no reload, and no guessing whether it has taken effect yet.

Two things the screen keeps reachable, because a block with no way out is just
a wall: **Sign out**, since it may be the wrong Google account, and **an
export** when the device holds anything. That second one is for the case that
makes a hard block unfair — somebody who had access, logged fill-ups and then
lost it would otherwise have their own data stranded behind a Settings screen
they can no longer open.

The rules suite reads that list **out of the rules file** rather than keeping
its own copy, so adding a person needs no test change, and emptying the list
fails the suite rather than silently locking everybody out. A separate check
fails while the list still holds a placeholder, which is what keeps a
switched-on-but-admitting-nobody allowlist off `main`.

One related console setting, and one correction to earlier advice:

- **Leave new sign-ups enabled** (Authentication → Settings → User actions).
  Turning them off sounds like defence in depth and is not: a person's uid does
  not exist until their first sign-in, so disabling sign-ups also blocks
  everybody you *want* to add. The allowlist is the gate — a stranger who signs
  in gets an auth record and nothing else, no reads, no writes, no quota. The
  only cost is rows accumulating in the user list.
- **There is no budget to alert on while the project is on the free Spark
  plan.** An earlier version of this page said to set a budget alert; that was
  wrong, because Spark has no billing account and stops serving rather than
  charging. The failure mode is the app going quiet. A budget alert becomes
  worth setting if the project is ever upgraded to Blaze, which is also the
  point at which the quota stops being a safety net.

Still not done, deliberately: **App Check**. The web config in the bundle is a
working client credential, and App Check is the mechanism that binds requests
to *this app* rather than to anyone who copied four strings out of the
JavaScript. The allowlist already stops an unknown account storing data, which
is the part that mattered; App Check would additionally stop a script hammering
the project's read quota using a known-good account's credentials. It needs a
reCAPTCHA integration plus a debug provider so the emulator suite and
`npm run dev` keep working, which is its own piece of work rather than a line
in this one.

## Signing out when the tab goes idle

Off by default, under Settings → Security: sign out after 5, 15, 30 or 60
minutes without a pointer or a keystroke. It exists because Firebase Auth
persists a session and never expires it, so a tab left open on a borrowed laptop
otherwise keeps access indefinitely.

What it does **not** do matters as much, and the setting says so next to the
switch rather than in a help page:

- **Signing out does not remove the fuel log.** The per-account database stays
  on the device on purpose, so signing back in finds the history and any edits
  that had not synced yet. Anyone who opens the browser's developer tools can
  still read it. This ends a session; it is a small addition to locking the
  device itself, which is the protection that actually matters.
- **Signing back in needs a connection.** A device that is offline cannot get
  back into the app until it reconnects. That is the trade for leaving this on,
  and it is why the default is off for an app that otherwise works offline.

The rule is a pure function (`domain/idleTimeout.ts`) and the browser part — the
activity marker, the events, the polling — is separate (`ui/idleTimeout.ts`), so
the thing that decides to end someone's session is tested directly rather than
inferred from a render. Two details are deliberate. The last-activity marker
lives in `localStorage`, so two tabs agree and nobody is signed out of the tab
they left open while they were working in the other one. And the fallbacks point
in **opposite directions on purpose**: an unreadable *period* becomes the
30-minute default, never "no timeout", because that failure would be invisible;
an unreadable *setting* reads as off, because there is then no evidence anybody
asked for this and signing them out would be an action they never requested.

## Local storage is separated by account

The IndexedDB database is named after the signed-in uid
(`fueltracker-u-<uid>`), and it is opened only once auth has resolved. That is a
fix, not a flourish: the first version of sign-in opened one database called
`fueltracker` for everyone, at module load, and never cleared it on sign-out. On
a shared computer that meant person B signing in got a store still holding
person A's rows — and the first sync exported them **into B's account**, where
they propagated to B's other devices.

Per-account names rather than clearing on sign-out, because clearing would
destroy local edits made before someone signed out and before a sync could carry
them up — turning a privacy fix into a data-loss one. Each person's rows stay on
the device under their own name, so signing back in finds them.

Data written before accounts existed is adopted once, into the first account to
sign in, and the legacy database is deleted only after the copy is verified by
row count. The adoption declines if the account already has rows, so it is a
one-time rescue rather than a rule that whoever signs in inherits whatever was
lying around. `accountStore.test.ts` covers all of that, including the leak
itself — and that test was checked by reverting the fix, to confirm it fails
against the old behaviour rather than merely passing against the new one.
