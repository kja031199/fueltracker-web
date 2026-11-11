<!--
  The checklist is CLAUDE.md's "Before opening a pull request", word for word;
  src/test/guardrails.test.ts keeps the two the same. Change it there first.
-->

## What changed

<!-- What and why, for someone who has not read the issue. -->

Closes #

## Tests

<!-- What was red before the change; hostile and edge cases; CI is the authority. -->

## Before opening a pull request

- [ ] The test was written first and seen to fail, and the PR says so.
- [ ] Mutation-tested, if it guards data or access — and the mutations recorded in
      `scripts/mutations/sets/`.
- [ ] `npm run build`, `npm test`, `npm run typecheck`, `npm run lint` — exit
      codes read directly, not through a pipe.
- [ ] Rules touched? Emulator suite run, and the field in its `…Keys()` list.
- [ ] No secrets and no Firebase config in the diff.
- [ ] Closes an issue? A note in `RELEASE_NOTES.md`, with the PR link once
      the pull request exists.
- [ ] `README.md`, `docs/` and this file re-read against the diff — a claim
      that is now false teaches the next reader to distrust the load-bearing
      ones. If nothing needed changing, say so in the PR.
