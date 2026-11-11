import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

/**
 * Each fact about the docs has one home (#100).
 *
 * The docs index was kept twice — in README.md and in docs/README.md — and the
 * README copy had already fallen behind (it never listed `csp-check.md`). The
 * command list was in README.md and docs/development.md, and both drifted.
 * Each now lives in one place, and the others link to it.
 */

const readme = readFileSync('README.md', 'utf8');
const index = readFileSync('docs/README.md', 'utf8');
const docs = readdirSync('docs').filter((name) => name.endsWith('.md') && name !== 'README.md');

describe('the docs index (#100)', () => {
  test('there are docs to index', () => {
    expect(docs.length).toBeGreaterThan(5);
  });

  test.each(docs)('docs/README.md lists %s', (name) => {
    expect(index).toContain(`](${name})`);
  });

  test('README.md links to the index rather than keeping a copy of it', () => {
    expect(readme).toContain('](docs/README.md)');
    // A table row per doc is what the copy looked like.
    expect(readme).not.toMatch(/^\| \[docs\//m);
  });
});

describe('the command list (#100)', () => {
  // The list itself: the first command block in the Development section, not
  // a mention anywhere in the file.
  const text = readFileSync('docs/development.md', 'utf8');
  const development = /^## Development\s*\n+```bash\n([\s\S]*?)```/m.exec(text)?.[1] ?? '';
  const scripts = Object.keys(
    (JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }).scripts,
  );

  test('the list is there to read', () => {
    expect(development).toMatch(/npm install/);
  });

  test.each(scripts.filter((name) => name !== 'test:watch' && name !== 'preview'))(
    'docs/development.md names npm script %s',
    (name) => {
      expect(development).toMatch(
        new RegExp(`npm (run )?${name.replace(':', '[:]')}\\b|\`${name.replace(':', '[:]')}\``),
      );
    },
  );

  test('README.md shows only how to start, and links to the full list', () => {
    expect(readme).toContain('](docs/development.md)');
    expect(readme).not.toMatch(/npm run test:rules/);
  });
});
