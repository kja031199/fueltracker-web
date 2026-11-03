import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

/**
 * The toolchain agrees with itself (#57).
 *
 * Each of these is drift that type checking cannot see, because the thing that
 * is wrong is the type checker's own premise.
 */

const json = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

const major = (version: unknown): number => Number(String(version).split('.')[0]);

const installed = (name: string): unknown => json(`node_modules/${name}/package.json`)['version'];

describe('React', () => {
  // A React 18 runtime type-checked against React 19's types compiled `use`,
  // ref-as-prop and `<Context>` as a provider — and then failed in the browser.
  test.each(['@types/react', '@types/react-dom'])(
    'the runtime and %s are the same major version',
    (types) => {
      expect(major(installed(types))).toBe(major(installed('react')));
    },
  );

  test('react and react-dom are the same major version', () => {
    expect(major(installed('react-dom'))).toBe(major(installed('react')));
  });
});

describe('the hooks lint', () => {
  const config = (): Record<string, unknown> =>
    existsSync('.oxlintrc.json') ? json('.oxlintrc.json') : {};
  const rules = (): Record<string, unknown> =>
    (config()['rules'] ?? {}) as Record<string, unknown>;

  test('both hooks rules are errors, so a finding fails the build', () => {
    expect(rules()['react-hooks/rules-of-hooks']).toBe('error');
    expect(rules()['react-hooks/exhaustive-deps']).toBe('error');
  });

  test('is an allowlist: no rule category is switched on wholesale', () => {
    // A version bump that adds rules to a category must not redden the branch.
    expect(existsSync('.oxlintrc.json')).toBe(true);
    const categories = (config()['categories'] ?? {}) as Record<string, unknown>;
    for (const level of Object.values(categories)) expect(level).toBe('off');
  });

  test('has a script, which is what CI runs', () => {
    const scripts = json('package.json')['scripts'] as Record<string, string>;
    expect(scripts['lint']).toMatch(/oxlint/);
  });
});

describe('the package says what the app is', () => {
  test('no longer claims there is no account and no server', () => {
    // Sign-in is required, and the log syncs to Firestore.
    const description = String(json('package.json')['description']);
    expect(description).not.toMatch(/no account|no server/i);
  });
});

describe('the type checker sees the build config', () => {
  test('vite.config.ts is in tsconfig include', () => {
    // Outside `include`, `tsc` never read it: its `test` block was an unknown
    // property to vite's own types, and nothing noticed. A type error planted
    // there fails `npm run typecheck` only while this holds.
    const include = json('tsconfig.json')['include'] as string[];
    expect(include).toContain('vite.config.ts');
  });
});

describe('the deploy hands the build its admin settings (#70)', () => {
  test('the inactivity period is passed from the repository Variable', () => {
    // Vite inlines VITE_* at build time. A Variable set in the repository but
    // not passed here would be silently ignored, and everyone would get the
    // default — exactly the kind of misconfiguration nobody notices.
    const workflow = readFileSync('.github/workflows/deploy.yml', 'utf8');
    expect(workflow).toMatch(/VITE_IDLE_TIMEOUT_MINUTES: \$\{\{ vars\.VITE_IDLE_TIMEOUT_MINUTES \}\}/);
  });
});
