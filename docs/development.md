# Working on this

Running it locally, and the checks every pull request goes through. If you are
an AI assistant working in this repository, read
[`CLAUDE.md`](../CLAUDE.md) as well — it holds the invariants and the traps.

## Development

```bash
npm install
npm run dev        # vite dev server
npm test           # vitest
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
| **Typecheck, test & build** | A type error, a ported assertion no longer holding, or an app that no longer builds |
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
| Sign-in adopting the legacy database (the #44 behaviour) | 3 |
| Sign-in copying legacy rows but keeping the original / deleting it uncopied | 2 / 2 |
| Sign-in merely opening the legacy database / opening the wrong account's | 1 / 1 |
| Dev guard: `dev` signal / hostname signal dropped | 1 / 8 |
| Dev guard: always refusing / id not normalised / constant wrong | 2 / 1 / 1 |
| Local-host check: unanchored `127.` / `includes('localhost')` / no lower-casing / `[::1]` dropped | 1 / 2 / 1 / 2 |

The first row is the one to understand before touching `firestore.rules`:
identity-only rules — the version that asked "is this your tree?" and nothing
else — still pass 13 fewer assertions than the current file, and wide-open
rules pass 20 fewer.
