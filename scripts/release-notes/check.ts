/**
 * The "Release notes" check: a pull request that closes an issue must add a
 * note for it to RELEASE_NOTES.md.
 *
 * Run by `.github/workflows/release-notes.yml` on the pull request's merge
 * commit, as `node --experimental-strip-types scripts/release-notes/check.ts`,
 * with the title and description in `PR_TITLE` and `PR_BODY`. Those two are
 * written by whoever opened the pull request, so they are only ever read as
 * data: they arrive through the environment, never through the workflow file.
 *
 * Node built-ins only and nothing to install, so the check is cheap and always
 * reports a status. The functions below are pure, and `releaseNotes.test.ts`
 * tests them.
 */

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const NOTES_FILE = 'RELEASE_NOTES.md';
const REPO = 'https://github.com/kja031199/fueltracker-web';

/** Sorted, without duplicates. */
function numbers(found: Iterable<string>): number[] {
  return [...new Set([...found].map(Number))].sort((a, b) => a - b);
}

/**
 * The issues a pull request says it closes: GitHub's closing keywords in the
 * description (`Closes #12`, `fixes: #3`, any case), and the `(#N)` this
 * repository puts in titles. A bare mention ("see #4", "part of #101") is not
 * a claim, and neither is another repository's issue (`owner/repo#9`).
 */
export function issuesClaimed(title: string, body: string | null | undefined): number[] {
  const text = body ?? '';
  // `\b` keeps "unfixed #3" from counting; `\s+#` keeps `owner/repo#9` out.
  const keyword = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+#(\d+)(?!\d)/gi;
  const inTitle = /\(#(\d+)\)/g;
  return numbers([
    ...[...text.matchAll(keyword)].map((match) => match[1]!),
    ...[...title.matchAll(inTitle)].map((match) => match[1]!),
  ]);
}

/** The issue and pull request numbers named on lines a diff **adds**. */
export function issuesNoted(diff: string): number[] {
  const added = diff
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .join('\n');
  return numbers([...added.matchAll(/#(\d+)(?!\d)/g)].map((match) => match[1]!));
}

/** Claimed issues with no note. */
export function missing(claimed: readonly number[], noted: readonly number[]): number[] {
  const have = new Set(noted);
  return claimed.filter((issue) => !have.has(issue));
}

function main(): number {
  const title = process.env['PR_TITLE'] ?? '';
  const body = process.env['PR_BODY'] ?? '';
  const claimed = issuesClaimed(title, body);
  if (claimed.length === 0) {
    console.log('This pull request closes no issue, so it needs no release note.');
    return 0;
  }
  // On a pull request, HEAD is the merge commit and HEAD^1 is the base branch:
  // this is exactly what the pull request changes in the notes.
  const diff = execFileSync('git', ['diff', '--unified=0', 'HEAD^1', 'HEAD', '--', NOTES_FILE], {
    encoding: 'utf8',
  });
  const absent = missing(claimed, issuesNoted(diff));
  if (absent.length === 0) {
    console.log(`Release notes cover ${claimed.map((issue) => `#${issue}`).join(', ')}.`);
    return 0;
  }
  for (const issue of absent) {
    console.log(
      `::error file=${NOTES_FILE}::This pull request closes #${issue} but adds no note for it to ${NOTES_FILE}.`,
    );
  }
  console.log(`
Add an entry under today's date (UTC), newest first, like:

- **What changed, as someone using the app would put it.** A sentence or two more.
  *Technical:* what changed in the code, briefly.
  [#${absent[0]}](${REPO}/issues/${absent[0]}) · [PR #<this PR>](${REPO}/pull/<this PR>)
`);
  return 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
