import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { issuesClaimed, issuesNoted, missing } from '../../scripts/release-notes/check';

/**
 * Release notes (`RELEASE_NOTES.md`): every pull request that closes an issue
 * adds a note for it, and the "Release notes" check refuses one that does not.
 * These pin how that check reads a pull request, and the shape of the file.
 */

/** A unified diff of RELEASE_NOTES.md adding and removing these lines. */
function diff(added: readonly string[], removed: readonly string[] = []): string {
  return [
    'diff --git a/RELEASE_NOTES.md b/RELEASE_NOTES.md',
    '--- a/RELEASE_NOTES.md',
    '+++ b/RELEASE_NOTES.md',
    '@@ -1,0 +1,2 @@',
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ].join('\n');
}

describe('which issues a pull request closes', () => {
  test('closing keywords in the description, in any case and form', () => {
    expect(issuesClaimed('', 'Closes #12, fixes #13.\n\nResolves: #5\nCLOSES #7\nfixed #8 and resolved #9')).toEqual([
      5, 7, 8, 9, 12, 13,
    ]);
  });

  test('the "(#N)" the repository puts in titles', () => {
    expect(issuesClaimed('Keep the deploy key away from the npm build toolchain (#76)', '')).toEqual([76]);
    expect(issuesClaimed('Fix two things (#3) (#4)', null)).toEqual([3, 4]);
  });

  test('a mention is not a claim, and another repository’s issue is not this one’s', () => {
    expect(
      issuesClaimed(
        'Mentions #4',
        'See issue #4, related to #6. Closes other/repo#9. Part of #101. Unfixed #3. Prefixes #2.',
      ),
    ).toEqual([]);
  });

  test('#12 is not #123', () => {
    expect(issuesClaimed('', 'Closes #123')).toEqual([123]);
  });

  test('nothing, empty and enormous descriptions', () => {
    expect(issuesClaimed('', null)).toEqual([]);
    expect(issuesClaimed('', undefined)).toEqual([]);
    expect(issuesClaimed('', '')).toEqual([]);
    expect(issuesClaimed('', `${'x'.repeat(100_000)} closes #42`)).toEqual([42]);
  });

  test('the same issue named twice is claimed once', () => {
    expect(issuesClaimed('Thing (#7)', 'Closes #7. Fixes #7.')).toEqual([7]);
  });
});

describe('which issues the pull request added notes for', () => {
  test('issue numbers on added lines', () => {
    expect(issuesNoted(diff(['- **A.** b. [#88](https://example/88) · [PR #112](https://example/112)']))).toEqual([
      88, 112,
    ]);
  });

  test('a removed line is not a note', () => {
    expect(issuesNoted(diff([], ['- **Old.** [#5](x)']))).toEqual([]);
  });

  test('the file header lines of the diff are not notes', () => {
    expect(issuesNoted('+++ b/RELEASE_NOTES.md #9\n--- a/RELEASE_NOTES.md #9')).toEqual([]);
  });

  test('#12 is not #123', () => {
    expect(issuesNoted(diff(['[#123](x)']))).toEqual([123]);
  });

  test('no diff at all', () => {
    expect(issuesNoted('')).toEqual([]);
  });
});

describe('what is missing', () => {
  test('a claimed issue without a note', () => {
    expect(missing([86, 88], [88])).toEqual([86]);
  });

  test('one note naming two issues covers both', () => {
    expect(missing([3, 4], issuesNoted(diff(['- **Both.** [#3](x) [#4](y)'])))).toEqual([]);
  });

  test('a note for a different issue does not count', () => {
    expect(missing([12], issuesNoted(diff(['- **Other.** [#123](x)'])))).toEqual([12]);
  });

  test('a pull request that closes nothing needs nothing', () => {
    expect(missing([], [])).toEqual([]);
  });
});

describe('RELEASE_NOTES.md', () => {
  const text = readFileSync('RELEASE_NOTES.md', 'utf8');
  const lines = text.split('\n');
  const REPO = 'https://github.com/kja031199/fueltracker-web';

  /** Each entry: a list item and its continuation lines, with the date it is under. */
  function entries(): { date: string; text: string }[] {
    const found: { date: string; text: string }[] = [];
    let date = '';
    for (const line of lines) {
      const heading = /^## (.*)$/.exec(line);
      if (heading !== null) {
        date = heading[1]!;
        continue;
      }
      if (line.startsWith('- ')) found.push({ date, text: line });
      else if (line.startsWith('  ') && found.length > 0) found[found.length - 1]!.text += `\n${line}`;
    }
    return found;
  }

  test('has entries, so a passing suite means something', () => {
    expect(entries().length).toBeGreaterThanOrEqual(13);
  });

  test('dates are real, and newest first with no date twice', () => {
    const dates = lines.filter((line) => line.startsWith('## ')).map((line) => line.slice(3));
    for (const date of dates) {
      expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10)).toBe(date);
    }
    expect([...dates].sort().reverse()).toEqual(dates);
    expect(new Set(dates).size).toBe(dates.length);
  });

  test('every entry is under a date', () => {
    for (const entry of entries()) expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('every entry has a sentence for users, a technical line, and a link to this repository', () => {
    for (const entry of entries()) {
      expect(entry.text, entry.text).toMatch(/^- \*\*[^*]+\*\*/);
      expect(entry.text, entry.text).toMatch(/\n {2}\*Technical:\* \S/);
      expect(entry.text, entry.text).toMatch(new RegExp(`\\]\\(${REPO}/(issues|pull)/\\d+\\)`));
    }
  });

  test('every link says the number it points at', () => {
    const links = [...text.matchAll(/\[(?:PR )?#(\d+)\]\((https:\/\/[^)]+)\)/g)];
    expect(links.length).toBeGreaterThan(0);
    for (const [whole, number, url] of links) {
      expect(url, whole).toMatch(new RegExp(`^${REPO}/(issues|pull)/${number}$`));
      // "PR #n" links a pull request; a bare "#n" links an issue.
      expect(url!.includes('/pull/'), whole).toBe(whole.startsWith('[PR '));
    }
  });

  test('nothing is left waiting under an undated heading', () => {
    expect(text).not.toMatch(/^## (?!\d{4}-\d{2}-\d{2}$)/m);
  });
});
