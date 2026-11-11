import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { behind, compareVersions, pinsIn, type Pin } from '../../scripts/pins/check';

/**
 * The binaries CI downloads by hand stay current (#99).
 *
 * gitleaks and lychee are fetched by version and checked against a pinned
 * SHA-256 (#46) — environment variables in `checks.yml` that Dependabot cannot
 * see. `scripts/pins/check.ts` reads them and asks GitHub for each tool's
 * latest release; `.github/workflows/pins.yml` runs it weekly and goes red when
 * a pin falls behind. The comparison and the reading are tested here.
 */

const CHECKS = `
jobs:
  secrets:
    env:
      GITLEAKS_VERSION: 8.24.3
      GITLEAKS_SHA256: abc
  links:
    env:
      LYCHEE_VERSION: v0.15.1
      LYCHEE_SHA256: def
`;

describe('reading the pins', () => {
  test('finds each tool, its version and where it is released', () => {
    expect(pinsIn(CHECKS)).toEqual<Pin[]>([
      { tool: 'gitleaks', repo: 'gitleaks/gitleaks', version: '8.24.3' },
      { tool: 'lychee', repo: 'lycheeverse/lychee', version: 'v0.15.1' },
    ]);
  });

  test('a pin that has gone missing is an error, not a quiet pass', () => {
    expect(() => pinsIn('jobs: {}')).toThrow(/GITLEAKS_VERSION/);
  });

  test('reads the real checks.yml', () => {
    const pins = pinsIn(readFileSync('.github/workflows/checks.yml', 'utf8'));
    expect(pins.map((pin) => pin.tool)).toEqual(['gitleaks', 'lychee']);
    // `8.30.1`, `v0.15.1`, or a release tag like `lychee-v0.24.2`.
    for (const pin of pins) expect(pin.version).toMatch(/^(?:[a-z-]*-)?v?\d+\.\d+\.\d+$/);
  });
});

describe('comparing versions', () => {
  test.each([
    ['8.24.3', '8.24.3', 0],
    ['v0.15.1', '0.15.1', 0],
    ['8.24.3', '8.25.0', -1],
    ['8.24.3', '9.0.0', -1],
    ['0.15.1', '0.9.9', 1],
    ['8.24.10', '8.24.9', 1],
  ] as const)('%s against %s', (a, b, sign) => {
    expect(Math.sign(compareVersions(a, b))).toBe(sign);
  });

  test.each(['', 'latest', '1.2', 'v1.2.x', '1.2.3-rc.1'])('refuses %j rather than guessing', (version) => {
    expect(() => compareVersions(version, '1.2.3')).toThrow(/not a version/);
  });

  test('a pin is behind only when the latest release is newer', () => {
    const pin: Pin = { tool: 'lychee', repo: 'lycheeverse/lychee', version: 'v0.15.1' };
    expect(behind(pin, 'v0.15.1')).toBe(false);
    expect(behind(pin, 'lychee-v0.16.0')).toBe(true);
    expect(behind(pin, 'v0.14.0')).toBe(false);
  });
});

describe('the workflow that runs it', () => {
  const workflow = readFileSync('.github/workflows/pins.yml', 'utf8');

  test('runs the check weekly and on demand, never on a pull request', () => {
    expect(workflow).toMatch(/^\s+schedule:\s*\n\s+(#[^\n]*\n\s+)*- cron: '[^']+'/m);
    expect(workflow).toMatch(/^\s+workflow_dispatch:/m);
    expect(workflow).not.toMatch(/^\s+pull_request:/m);
    expect(workflow).toMatch(/run: node --experimental-strip-types scripts\/pins\/check\.ts\s*$/m);
  });
});

describe('the docs never quote a pin (#99)', () => {
  // A version written in prose is a second copy of the pin, and it goes stale
  // on the next bump without anything noticing. Say "the pinned version".
  const pins = [
    // The bare number, so `lychee 0.24.2` in prose is caught as well as the tag.
    ...pinsIn(readFileSync('.github/workflows/checks.yml', 'utf8')).map((pin) =>
      pin.version.replace(/^(?:[a-z-]*-)?v?/, ''),
    ),
    (JSON.parse(readFileSync('.github/firebase-cli/package.json', 'utf8')) as { dependencies: Record<string, string> })
      .dependencies['firebase-tools']!,
  ];
  const docs = [
    'README.md',
    'CLAUDE.md',
    ...readdirSync('docs')
      .filter((name) => name.endsWith('.md'))
      .map((name) => `docs/${name}`),
  ];

  test('there are pins and docs to check', () => {
    expect(pins).toHaveLength(3);
    expect(docs.length).toBeGreaterThan(5);
  });

  test.each(docs)('%s', (file) => {
    const text = readFileSync(file, 'utf8');
    for (const version of pins)
      expect(text, `${file} quotes ${version}`).not.toMatch(new RegExp(`\\bv?${version.replaceAll('.', '\\.')}\\b`));
  });
});
