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

describe('the deploy smoke test proves configuration was baked in', () => {
  const deploy = readFileSync(`${WORKFLOW_DIR}/deploy.yml`, 'utf8');
  const bundleCheck = deploy
    .split('\n')
    .find((line) => line.includes('$url$bundle') && line.includes('grep'));

  test('there is a bundle check to inspect', () => {
    expect(bundleCheck).toBeDefined();
  });

  test('it looks for the app id, not the project id', () => {
    // Issue #45 put the production project id into the source as a constant
    // (`PRODUCTION_PROJECT_ID`, for the development guard), so it is now in
    // every main bundle — configured or not. A smoke test grepping for it would
    // pass for a site built with no configuration at all. The app id reaches
    // the bundle only from `VITE_FIREBASE_APP_ID` at build time.
    expect(bundleCheck).toContain('$VITE_FIREBASE_APP_ID');
    expect(bundleCheck).not.toContain('$VITE_FIREBASE_PROJECT_ID');
  });

  test('it matches the app id as a fixed string', () => {
    // An app id is `1:<number>:web:<hex>`; read as a regex it happens to be
    // harmless, but the check should not depend on that.
    expect(bundleCheck).toMatch(/grep -qF /);
  });
});

/**
 * One workflow step per entry, split on the `- name:` / `- uses:` / `- run:`
 * line that starts it.
 *
 * Deliberately crude: it reads YAML as lines, as the rest of this file does,
 * rather than adding a YAML parser to the dev dependencies for one test. The
 * guard-the-guard counts below are what catch it if the crudeness ever stops
 * finding what it is looking for.
 */
function steps(): { workflow: string; text: string }[] {
  return workflows().flatMap(({ name, text }) => {
    const chunks: string[] = [];
    let current: string[] | null = null;
    for (const line of text.split('\n')) {
      if (/^\s+- (name|uses|run):/.test(line)) {
        if (current !== null) chunks.push(current.join('\n'));
        current = [line];
      } else if (/^\S/.test(line) || /^ {2}\S/.test(line) || /^ {4}[a-z-]+:/.test(line)) {
        // A top-level key, a job id, or a job-level key such as `env:` ends the
        // current step — otherwise the next job's env would be read as part of
        // the previous job's last step.
        if (current !== null) chunks.push(current.join('\n'));
        current = null;
      } else if (current !== null) {
        current.push(line);
      }
    }
    if (current !== null) chunks.push(current.join('\n'));
    return chunks.map((chunk) => ({ workflow: name, text: chunk }));
  });
}

/** Lines that run, not lines that explain. */
function commands(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
}

describe('downloaded binaries are verified before they run', () => {
  // Issue #46. gitleaks and lychee were fetched by version and trusted as-is.
  // A replaced release asset would turn a required check into a green tick
  // that checks nothing — and the secret scan exists for exactly the day it
  // is needed, on a public repository that has had a token pasted into it.
  const downloads = steps().filter(({ text }) => /releases\/download/.test(commands(text)));

  test('there are downloads to check, so a passing suite means something', () => {
    expect(downloads.map(({ workflow }) => workflow)).toEqual(['checks.yml', 'checks.yml']);
  });

  test.each(downloads)('$workflow verifies a SHA-256 before extracting', ({ workflow, text }) => {
    const run = commands(text);
    const verify = run.search(/sha256sum (-c|--check)/);
    // `tar` as a command — at the start of a line or after a pipe — not the
    // `.tar.gz` in the file name, which appears first.
    const extract = run.search(/(^|\|)\s*tar\s+-/m);
    expect(verify, `${workflow}: no checksum verification`).toBeGreaterThan(-1);
    expect(extract, `${workflow}: nothing extracted?`).toBeGreaterThan(-1);
    // Order matters: verifying after extraction has already run the archive
    // through tar, and a pipe straight into tar never sees the file at all.
    expect(verify).toBeLessThan(extract);
    expect(run).not.toMatch(/\|\s*tar\b/);
  });

  test.each(downloads)('$workflow checks against a pinned hash, not one it fetched', ({ workflow, text }) => {
    // A checksum downloaded from the same place as the tarball proves only
    // that the two were replaced together. The expected value has to live in
    // this repository, where changing it is a reviewed diff.
    const name = /\$\{?([A-Z0-9_]+_SHA256)\}?/.exec(commands(text))?.[1];
    expect(name, `${workflow}: the check names no *_SHA256 variable`).toBeDefined();
    const source = readFileSync(`${WORKFLOW_DIR}/${workflow}`, 'utf8');
    expect(source).toMatch(new RegExp(`\\b${name}:\\s*[0-9a-f]{64}\\b`));
  });
});

describe('checkout does not leave the token behind', () => {
  // Issue #46. `persist-credentials` defaults to true: the GITHUB_TOKEN stays
  // in `.git/config` for every later step, including `npm ci` runs that execute
  // several hundred packages' lifecycle scripts. Nothing after checkout needs
  // git authentication.
  const checkouts = steps().filter(({ text }) => /uses:\s*actions\/checkout@/.test(text));

  test('there are checkouts to check', () => {
    expect(checkouts.length).toBeGreaterThanOrEqual(5);
  });

  test.each(checkouts)('$workflow sets persist-credentials: false', ({ text }) => {
    expect(commands(text)).toMatch(/^\s+persist-credentials:\s*false\s*$/m);
  });
});
