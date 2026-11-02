import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

/**
 * What the workflows are allowed to run, as an assertion rather than a habit.
 *
 * Issue #30. `deploy.yml` writes the service-account key to the runner and then
 * ran `npx --yes firebase-tools` — which resolves **whatever version is newest
 * at that moment**, downloads it with its several hundred transitive
 * dependencies, and executes it in a process that can read the key and reach
 * the network. It was not in `package.json`, so not in `package-lock.json`, so
 * `npm ci` never saw it and the Dependabot config added in #22 did not cover
 * it. The one dependency trusted with a credential was the only one with no
 * version floor, no integrity hash and no update review.
 *
 * Pinning is the fix, and a pin that nothing checks comes undone the next time
 * somebody adds a step in a hurry. Hence this file: it runs inside the
 * required "Typecheck, test & build" check, so an unpinned action or an
 * unpinned CLI cannot reach `main` without a reviewer deciding to ignore a red
 * build.
 */

const WORKFLOW_DIR = '.github/workflows';

function workflows(): { name: string; text: string }[] {
  return readdirSync(WORKFLOW_DIR)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .map((name) => ({ name, text: readFileSync(`${WORKFLOW_DIR}/${name}`, 'utf8') }));
}

/** Every `uses:` line, with the workflow it came from. */
function usesLines(): { workflow: string; line: string }[] {
  return workflows().flatMap(({ name, text }) =>
    text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('uses:') || line.startsWith('- uses:'))
      .map((line) => ({ workflow: name, line })),
  );
}

describe('every action is pinned to a commit', () => {
  test('there are actions to check, so a passing suite means something', () => {
    // Guards the guard: a glob that matched nothing would report a clean
    // repository for ever.
    expect(usesLines().length).toBeGreaterThan(0);
  });

  test.each(usesLines())('$workflow pins $line', ({ line }) => {
    // A tag is mutable. `actions/checkout@v7` is whatever that tag points at
    // today, which is a different commit from the one it pointed at last
    // month — and in a workflow holding a deploy credential, "whatever it
    // points at" is not a thing to be relaxed about. These are GitHub's own
    // actions, so this is defence in depth rather than a live threat; it is
    // also one line each.
    expect(line).toMatch(/@[0-9a-f]{40}\b/);
  });

  test.each(usesLines())('$workflow says which version $line is', ({ line }) => {
    // A bare SHA is unreadable. The trailing comment is what lets a reviewer
    // see that a bump went from v7.0.1 to v7.1.0 rather than sideways into
    // somebody's fork, and it is what Dependabot maintains.
    expect(line).toMatch(/#\s*v?\d+\.\d+\.\d+/);
  });
});

describe('the Firebase CLI is pinned and installed from a lockfile', () => {
  test('no workflow resolves it at run time with npx', () => {
    // Comment-only lines are excluded: the prose in `deploy.yml` explains what
    // the old command was and why it was replaced, and a test that could be
    // satisfied by rewording a comment — or broken by writing one — is
    // asserting about the wrong thing. What matters is that nothing *runs* it.
    for (const { name, text } of workflows()) {
      const commands = text
        .split('\n')
        .filter((line) => !line.trim().startsWith('#'))
        .join('\n');
      expect(commands, `${name} still resolves firebase-tools at run time`).not.toMatch(
        /npx[^\n]*firebase-tools/,
      );
    }
  });

  test('its manifest pins an exact version, not a range', () => {
    const manifest = JSON.parse(
      readFileSync('.github/firebase-cli/package.json', 'utf8'),
    ) as { dependencies?: Record<string, string> };
    const version = manifest.dependencies?.['firebase-tools'];
    expect(version).toBeDefined();
    // No `^`, no `~`, no `*`, no range: one version, chosen deliberately.
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('it has a lockfile of its own, so the whole tree is integrity-checked', () => {
    // The point of a separate directory: `npm ci` there verifies every
    // transitive package against a recorded hash, which `npx` does not do —
    // without dragging a few hundred build-time dependencies into the app's
    // own tree, where #19's audit assessment would have to be redone.
    const lock = JSON.parse(readFileSync('.github/firebase-cli/package-lock.json', 'utf8')) as {
      lockfileVersion?: number;
      packages?: Record<string, { resolved?: string; integrity?: string }>;
    };
    expect(lock.lockfileVersion).toBeGreaterThanOrEqual(2);
    const entries = Object.entries(lock.packages ?? {}).filter(([path]) => path !== '');
    expect(entries.length).toBeGreaterThan(50);
    const withoutIntegrity = entries
      .filter(([, meta]) => meta.resolved !== undefined && meta.integrity === undefined)
      .map(([path]) => path);
    expect(withoutIntegrity).toEqual([]);
  });

  test('the workflows that need it install it from that lockfile', () => {
    const needed = ['deploy.yml', 'ci.yml'];
    for (const name of needed) {
      const text = readFileSync(`${WORKFLOW_DIR}/${name}`, 'utf8');
      if (!/firebase/.test(text)) continue;
      expect(text, `${name} should install the pinned CLI`).toMatch(
        /npm ci --prefix \.github\/firebase-cli/,
      );
      expect(text, `${name} should run the pinned binary`).toMatch(
        /\.github\/firebase-cli\/node_modules\/\.bin\/firebase/,
      );
    }
  });
});

describe('dependabot watches what it needs to', () => {
  test('the Firebase CLI directory is covered, or its pin never gets reviewed', () => {
    // A pin with nothing proposing updates is a pin that rots. This is the
    // difference between "pinned" and "frozen".
    const config = readFileSync('.github/dependabot.yml', 'utf8');
    expect(config).toMatch(/\.github\/firebase-cli/);
  });
});
