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

**One written exception: a car you choose to share** — see
[Sharing a car](#sharing-a-car-66) below. It opens that one car to the people
who accept your invitation, and nothing else of yours.

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

Everyone is signed out after a period without a pointer or a keystroke — **30
minutes unless the administrator sets otherwise**. It exists because Firebase
Auth persists a session and never expires it, so a tab left open on a borrowed
laptop otherwise keeps access indefinitely.

**It is not a setting** (#70). It used to be an opt-in under Settings →
Security, off by default, with a choice of period per browser. Now one period
applies to every user, always, and Settings only states it:

- **The administrator sets it** with the `VITE_IDLE_TIMEOUT_MINUTES`
  repository Variable (Settings → Secrets and variables → Actions → Variables),
  next to the Firebase ones. It is read at build time, so a change takes effect
  on the next deploy; an open tab keeps the old period until the update
  reaches it. See [deploying.md](deploying.md#deploys-happen-on-merge).
- **A missing or malformed value means 30 minutes, never "no timeout".** Whole
  minutes only: unset, empty, `0`, `off`, `7.5`, `1e3` and `30min` all become
  30, and anything past a day is held to a day (1440). There is deliberately
  **no off value** — switching the protection off is a code change, not a
  typo or a forgotten Variable, because failing open is the failure nobody
  notices.
- **Old per-browser choices are deleted, not honoured.** The app removes the
  pre-#70 `fueltracker.idleTimeout` entry at startup without reading it, so a
  browser that had switched the timeout off, or chosen a longer period, cannot
  opt out.

What it does **not** do matters as much, and Settings says so next to the
period rather than in a help page:

- **Signing out does not remove the fuel log.** The per-account database stays
  on the device on purpose, so signing back in finds the history and any edits
  that had not synced yet. Anyone who opens the browser's developer tools can
  still read it. This ends a session; it is a small addition to locking the
  device itself, which is the protection that actually matters.
- **It is enforced by the app, on the device.** It is not a server-side session
  limit: someone with DevTools can stop it, and the Firebase refresh token keeps
  its own lifetime. Ending sessions on the server would be separate work.
- **Signing back in needs a connection.** A device that is offline cannot get
  back into the app until it reconnects — the trade an always-on timeout makes
  for an app that otherwise works offline.

The rule is a pure function (`domain/idleTimeout.ts`) and the browser part — the
activity marker, the events, the polling — is separate (`ui/idleTimeout.ts`), so
the thing that decides to end someone's session is tested directly rather than
inferred from a render. The last-activity marker lives in `localStorage`,
browser-wide rather than per account, so two tabs agree and nobody is signed out
of the tab they left open while they were working in the other one. An
unbelievable marker — unreadable, or in the future after a clock change —
restarts the countdown rather than ending the session or holding it open.

## Sharing a car (#66)

Two people who drive one car — a couple, say — can both log its fill-ups and
both see everything: every fill-up, the economy, the costs and the charts.

**How it works for the people using it.** The owner opens Vehicles → Share on
a car and enters the other person's Google address. The next time that person
opens FuelTracker, a banner asks whether to accept; nothing is shared until
they do. From then on the car appears for both, says who logged each fill-up,
and either can add, correct and delete its fill-ups. The owner can remove
someone, the other person can leave, and either way the car disappears from
their devices. The other person must be on the [allowlist](#who-can-sign-in)
like anyone else.

**What is exposed, said before anything is shared.** The car's whole history —
receipt photos, notes and stations included — and nothing else of the
owner's: not their other cars, not their other fill-ups, not submissions.

**Where the data lives: in the owner's account.** The car stays where it was,
and `firestore.rules` lets the people listed under that car's `members` read
it and read and write **its** fill-ups. No data moves when a car is shared,
so an existing car and its whole history can be shared as it is.

- **Joining needs an invitation to your own verified Google address.** The
  rules compare the invitation with the address on the sign-in, lowercased,
  and only when Google has verified it. Nobody can add anyone else, and a
  member cannot add a third person.
- **A member's fill-ups carry their own uid** (`enteredBy`), which the rules
  require on a new one and forbid changing on an edit or a deletion. A member
  cannot move a fill-up to another car, write the car itself, or erase a
  fill-up outright — a deletion is a tombstone, as everywhere else.
- **Membership is kept apart from the car's record**, in its own `members`
  subcollection, so the owner's sync — which pushes the car record whole —
  can never overwrite somebody joining.
- **The member's own account lists the shares** (`memberships`), so their
  other devices find the car too.

**When it ends** — removed, left, or the owner deleted the car — the car is
removed from the member's devices with no trace pushed anywhere: those rows
were never the member's to delete. Fill-ups the member logged **and synced**
stay with the owner. One logged but not yet synced when access ends goes with
the car, because there is nowhere left it may be sent.

The rules are pinned on the emulator by `sharingRules.test.ts`, and the whole
two-person flow — invite, accept, both logging, removal — runs end to end
against the real rules in `sharing.test.ts`.

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

`accountStore.test.ts` covers the leak itself, and that test was checked by
reverting the fix, to confirm it fails against the old behaviour rather than
merely passing against the new one.

### So is the state kept beside it (#55)

The *data* was separated in #44; the small pieces of *state* kept in
`localStorage` were not, and three of them belong to a person rather than to a
device. On a shared computer, account B:

- could go without a **backup reminder** while holding data that existed
  nowhere else, because the reminder compared B's fill-ups with A's last export;
- was shown the time of **A's last sync** in Settings;
- was never **welcomed**, because A already had been.

Every key now goes through `ui/preferences.ts` and declares whose it is:

| Scope | Keys | Stored as |
|---|---|---|
| browser | units, last-activity marker, CSP watcher | `fueltracker.<name>` (unchanged) |
| account | last backup, last sync, welcomed | `fueltracker.<name>.u.<uid>` |

The activity marker stays with the browser on purpose, so two tabs agree. (The
idle sign-out *setting* was a browser key too, until #70 made the period the
administrator's; its old entry is deleted at startup.)

**Values written before the split are dropped, not adopted.** Nobody can tell
which account wrote an unscoped `fueltracker.lastBackup`, and adopting it would
hand one person's state to whoever signs in next — the same mistake as the
pre-accounts rescue below. The cost is small and errs towards saying too much: a
backup reminder may appear once, and "Last synced" reads "not yet" until the
sync that runs on sign-in.

`AccountState.test.tsx` plays the shared-device cases through the real app, and
`storageBoundary.test.ts` keeps `preferences.ts` the only module that touches
web storage, so a new key cannot quietly skip the question.

### Data from before accounts existed is left where it is

The pre-accounts build kept everything in a database called `fueltracker`.
There used to be a one-time rescue that copied it into the first account to
sign in and then deleted it. **It was removed in #44**, because it ran on
sign-in — before any sync, so before anything knew whether that account was on
the [allowlist](#who-can-sign-in). On a device that still held a legacy
database, a stranger signing in first received the owner's rows, the owner's
copy was deleted, and the no-access screen then offered the stranger an export
of them.

The rule now is that **nothing that runs on sign-in moves data into an
account**. A per-account store holds what that account wrote and what its own
sync brought down, nothing else. Moving the rescue to after a successful sync
was considered and not done: it was a migration for a transition that
finished long ago, every device the owner has used since then adopted its data
at the time, and keeping it would keep a path alive whose only remaining users
are hypothetical.

A legacy database that still exists is left untouched. If one ever matters,
its rows are readable in the browser's DevTools under **Application →
IndexedDB → `fueltracker`**.
