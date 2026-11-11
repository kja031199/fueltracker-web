import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { coverageTable } from '../../scripts/coverage/summary';

/**
 * The small guardrails #99 asked for, each held to what it promises.
 */

const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
};

describe('the pull request template', () => {
  // CLAUDE.md's checklist is the source; the template is what a pull request
  // starts from. Read from one, checked against the other, so they cannot
  // drift apart.
  const claude = readFileSync('CLAUDE.md', 'utf8');
  const section = claude.slice(claude.indexOf('## Before opening a pull request'));
  const items = [...section.matchAll(/^- \[ \] (.+)$/gm)].map((match) => match[1]!.trim());

  test('exists, and the checklist it copies has items', () => {
    expect(existsSync('.github/pull_request_template.md')).toBe(true);
    expect(items.length).toBeGreaterThanOrEqual(5);
  });

  test.each(items)('carries "%s"', (item) => {
    const template = readFileSync('.github/pull_request_template.md', 'utf8');
    expect(template).toContain(`- [ ] ${item}`);
  });
});

describe('the formatting commit is out of git blame', () => {
  test('.git-blame-ignore-revs lists it, as a full hash', () => {
    const revs = readFileSync('.git-blame-ignore-revs', 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.startsWith('#'));
    expect(revs).toContain('c6b8b462cfe391e748f4297ec93e9b7da5947402');
    for (const rev of revs) expect(rev).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('the OCR browser check', () => {
  test('uses a pinned Playwright from the lockfile, not whatever is installed globally', () => {
    expect(manifest.devDependencies['playwright']).toMatch(/^\d+\.\d+\.\d+$/);
    const check = readFileSync('scripts/ocr-check/check.mjs', 'utf8');
    expect(check).not.toMatch(/npm root -g/);
    expect(check).not.toMatch(/--no-save playwright/);
  });

  test('has a script', () => {
    expect(manifest.scripts['check:ocr']).toBe('node scripts/ocr-check/check.mjs');
  });
});

describe('coverage', () => {
  test('is measured over the main suite, and reported, never enforced', () => {
    expect(manifest.scripts['test:coverage']).toBe('vitest run --project unit --project dom --coverage');
    expect(manifest.devDependencies['@vitest/coverage-v8']).toBeDefined();
    const config = readFileSync('vite.config.ts', 'utf8');
    // Informational on purpose (#99): a threshold turns a number into a target.
    expect(config).not.toMatch(/thresholds\s*:/);
  });
});

describe('the coverage summary', () => {
  const total = (pct: number) => ({ total: pct, covered: 0, skipped: 0, pct });
  const json = {
    total: { lines: total(81.234), statements: total(80), functions: total(75.5), branches: total(70) },
  };

  test('is a table of the four totals, to one decimal', () => {
    const table = coverageTable(JSON.stringify(json));
    expect(table).toContain('| Lines | 81.2% |');
    expect(table).toContain('| Branches | 70.0% |');
    expect(table).toMatch(/^## Coverage/);
  });

  test.each([
    ['nothing at all', null],
    ['not JSON', 'not json {'],
    ['no total', '{}'],
    ['a total that is not a number', JSON.stringify({ total: { lines: { pct: 'many' } } })],
  ] as const)('with %s says so rather than failing the job', (_label, text) => {
    expect(coverageTable(text)).toMatch(/No coverage summary/);
  });
});

describe('leftovers', () => {
  test('nothing reads PAGES_BASE, which only GitHub Pages ever set', () => {
    expect(readFileSync('vite.config.ts', 'utf8')).not.toMatch(/PAGES_BASE/);
  });
});
