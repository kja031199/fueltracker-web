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

/**
 * One entry per job, split on the 2-space job ids under `jobs:`. Line-based,
 * like `steps()`; the counts below catch it if it stops finding jobs.
 */
function jobs(): { workflow: string; id: string; text: string }[] {
  return workflows().flatMap(({ name, text }) => {
    const lines = text.split('\n');
    const start = lines.findIndex((line) => /^jobs:\s*$/.test(line));
    if (start === -1) return [];
    const found: { workflow: string; id: string; text: string }[] = [];
    let current: { id: string; lines: string[] } | null = null;
    for (const line of lines.slice(start + 1)) {
      const id = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line)?.[1];
      if (id !== undefined) {
        if (current !== null) found.push({ workflow: name, id: current.id, text: current.lines.join('\n') });
        current = { id, lines: [] };
      } else if (/^\S/.test(line)) {
        break;
      } else if (current !== null) {
        current.lines.push(line);
      }
    }
    if (current !== null) found.push({ workflow: name, id: current.id, text: current.lines.join('\n') });
    return found;
  });
}

/** The steps of one job's text, in order, as `steps()` splits them. */
function stepsOf(jobText: string): string[] {
  const chunks: string[] = [];
  let current: string[] | null = null;
  for (const line of jobText.split('\n')) {
    if (/^\s+- (name|uses|run):/.test(line)) {
      if (current !== null) chunks.push(current.join('\n'));
      current = [line];
    } else if (/^ {4}[a-z-]+:/.test(line)) {
      if (current !== null) chunks.push(current.join('\n'));
      current = null;
    } else if (current !== null) {
      current.push(line);
    }
  }
  if (current !== null) chunks.push(current.join('\n'));
  return chunks;
}

describe('the deploy key never meets the build toolchain (#76)', () => {
  // The key used to be written in the same job that had already run `npm ci`
  // — several hundred packages' lifecycle scripts — and before
  // `firebase deploy --only hosting`, whose `predeploy` hook ran
  // `npm run build`: vite and every plugin, with the key on disk and named in
  // GOOGLE_APPLICATION_CREDENTIALS. One compromised build dependency could
  // then deploy wide-open rules or its own JavaScript.
  const all = jobs();
  const keyJobs = all.filter(({ text }) => /secrets\.FIREBASE_SERVICE_ACCOUNT/.test(text));
  const keyJob = keyJobs[0];
  const keySteps = keyJob === undefined ? [] : stepsOf(keyJob.text);
  const index = (pattern: RegExp): number => keySteps.findIndex((step) => pattern.test(commands(step)));
  const writesKey = index(/firebase-key\.json/);

  test('there are jobs to check, and exactly one holds the key', () => {
    expect(all.length).toBeGreaterThanOrEqual(4);
    expect(keyJobs.map(({ workflow, id }) => `${workflow}:${id}`)).toEqual(['deploy.yml:deploy']);
  });

  test('no other job anywhere reads a secret', () => {
    const others = all.filter((job) => job !== keyJob && /secrets\./.test(commands(job.text)));
    expect(others.map(({ workflow, id }) => `${workflow}:${id}`)).toEqual([]);
  });

  test('the key job is reachable only through the production environment, after the build', () => {
    // The environment is limited to `main` in the repository settings, and the
    // key is an environment secret: a branch that edits this file, or a manual
    // run from another branch, cannot reach it.
    expect(keyJob?.text).toMatch(/^ {4}environment:\s*production\s*$/m);
    expect(keyJob?.text).toMatch(/^ {4}needs:\s*build\s*$/m);
  });

  test('the key job installs nothing with lifecycle scripts', () => {
    const installs = keySteps.filter((step) => /\bnpm (ci|install|i)\b/.test(commands(step)));
    expect(installs.length).toBeGreaterThan(0);
    for (const step of installs) expect(commands(step)).toMatch(/--ignore-scripts/);
  });

  test('the key job runs no app-tree tooling: no build, no tests, no tsc', () => {
    const run = commands(keyJob?.text ?? '');
    expect(run).not.toMatch(/\bnpm (run|test|install|i)\b/);
    expect(run).not.toMatch(/\bnpx\b/);
    expect(run).not.toMatch(/\bvite\b/);
    expect(run).not.toMatch(/\btsc\b/);
  });

  test('it deploys with a config that has no predeploy hook', () => {
    const deploys = keySteps.filter((step) => /firebase deploy/.test(commands(step)));
    expect(deploys.length).toBe(2);
    for (const step of deploys) expect(commands(step)).toMatch(/--config firebase\.ci\.json/);
    expect(commands(keyJob?.text ?? '')).toMatch(/jq[^\n]*del\(\.hosting\.predeploy\)[^\n]*firebase\.ci\.json/);
  });

  test('it ships the artifact the build job tested', () => {
    const build = all.find(({ workflow, id }) => workflow === 'deploy.yml' && id === 'build');
    expect(build?.text).toMatch(/uses:\s*actions\/upload-artifact@/);
    expect(build?.text).toMatch(/path:\s*dist\/?\s*$/m);
    expect(build?.text).toMatch(/\bnpm test\b/);
    expect(keyJob?.text).toMatch(/uses:\s*actions\/download-artifact@/);
  });

  test('the key is written last: after every install, the download and the config', () => {
    expect(writesKey).toBeGreaterThan(-1);
    const download = keySteps.findIndex((step) => /actions\/download-artifact@/.test(step));
    const lastInstall = Math.max(
      ...keySteps.map((step, i) => (/\bnpm ci\b/.test(commands(step)) ? i : -1)),
    );
    const config = index(/firebase\.ci\.json/);
    expect(download).toBeGreaterThan(-1);
    expect(download).toBeLessThan(writesKey);
    expect(lastInstall).toBeGreaterThan(-1);
    expect(lastInstall).toBeLessThan(writesKey);
    expect(config).toBeLessThan(writesKey);
  });
});

/**
 * The command a step runs: its `run:` line and the lines indented deeper than
 * the `run` key. The next key at the same depth (`env:` after it, say) ends it.
 */
function runBlock(step: string): string {
  const lines = step.split('\n');
  const start = lines.findIndex((line) => /^\s*(- )?run:/.test(line));
  if (start === -1) return '';
  const column = lines[start]!.indexOf('run:');
  const block = [lines[start]!];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && line.search(/\S/) <= column) break;
    block.push(line);
  }
  return block.join('\n');
}

describe('text a pull request author wrote never becomes a command', () => {
  // A pull request's title, description and branch name are written by
  // whoever opened it. `${{ }}` is expanded into the script before the shell
  // sees it, so one inside `run:` lets that text run as a command. Through
  // `env:` it is only ever a value.
  const UNTRUSTED = /\$\{\{\s*github\.(event\.(pull_request|issue|comment|review|head_commit)|head_ref)/;
  const runs = steps().filter(({ text }) => runBlock(text) !== '');

  test('there are run steps to check, and one reads a pull request’s text', () => {
    expect(runs.length).toBeGreaterThanOrEqual(10);
    expect(steps().some(({ text }) => UNTRUSTED.test(text))).toBe(true);
  });

  test.each(runs)('$workflow: no untrusted expression inside run', ({ text }) => {
    expect(runBlock(text)).not.toMatch(UNTRUSTED);
  });
});

describe('the release-notes check (RELEASE_NOTES.md)', () => {
  const text = readFileSync(`${WORKFLOW_DIR}/release-notes.yml`, 'utf8');

  test('runs on every pull request, and again when its title or description is edited', () => {
    expect(text).toMatch(/^on:\s*\n\s+pull_request:\s*\n\s+types:\s*\[opened, synchronize, reopened, edited\]/m);
  });

  test('is a job named "Release notes" that runs the checker on the merge commit', () => {
    expect(text).toMatch(/^\s+name: Release notes\s*$/m);
    expect(text).toMatch(/fetch-depth:\s*2/);
    expect(text).toMatch(/run: node --experimental-strip-types scripts\/release-notes\/check\.ts\s*$/m);
  });

  test('hands it the title and description through the environment', () => {
    expect(text).toMatch(/PR_TITLE:\s*\$\{\{\s*github\.event\.pull_request\.title\s*\}\}/);
    expect(text).toMatch(/PR_BODY:\s*\$\{\{\s*github\.event\.pull_request\.body\s*\}\}/);
  });
});
