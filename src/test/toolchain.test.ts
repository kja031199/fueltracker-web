import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  test.each(['@types/react', '@types/react-dom'])('the runtime and %s are the same major version', (types) => {
    expect(major(installed(types))).toBe(major(installed('react')));
  });

  test('react and react-dom are the same major version', () => {
    expect(major(installed('react-dom'))).toBe(major(installed('react')));
  });
});

describe('the hooks lint', () => {
  const config = (): Record<string, unknown> => (existsSync('.oxlintrc.json') ? json('.oxlintrc.json') : {});
  const rules = (): Record<string, unknown> => (config()['rules'] ?? {}) as Record<string, unknown>;

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

describe('the app says what it is', () => {
  // Sign-in is required, and the log syncs to Firestore. Checking only
  // package.json missed the two places a reader actually sees: the page's
  // meta description and the installed app's manifest description.
  const NO_ACCOUNT = /no account|no server/i;

  test('the package no longer claims there is no account and no server', () => {
    expect(String(json('package.json')['description'])).not.toMatch(NO_ACCOUNT);
  });

  test('nor does the page description', () => {
    expect(readFileSync('index.html', 'utf8')).not.toMatch(NO_ACCOUNT);
  });

  test('nor does the installed app, through its manifest', () => {
    expect(readFileSync('vite.config.ts', 'utf8')).not.toMatch(NO_ACCOUNT);
  });
});

describe('the type checker sees the build config', () => {
  test('vite.config.ts is in the test project include', () => {
    // Outside `include`, `tsc` never read it: its `test` block was an unknown
    // property to vite's own types, and nothing noticed. A type error planted
    // there fails `npm run typecheck` only while this holds.
    const include = json('tsconfig.test.json')['include'] as string[];
    expect(include).toContain('vite.config.ts');
  });
});

/**
 * App code gets no test or Node types (#97).
 *
 * One `tsconfig.json` used to give every file `vitest/globals`, `jest-dom`
 * and `node`, so browser code could name `describe` or `process` and type-check
 * — and then throw in the browser. Now there are two projects: `app` (the app,
 * DOM types only) and `test` (the tests, `src/test/` and `vite.config.ts`,
 * with the test and Node types), joined by references and checked by `tsc -b`.
 */
describe('the type checker keeps test types out of app code (#97)', () => {
  const compilerOptions = (path: string): Record<string, unknown> =>
    json(path)['compilerOptions'] as Record<string, unknown>;

  test('tsconfig.json is just the two projects', () => {
    expect(json('tsconfig.json')).toEqual({
      files: [],
      references: [{ path: './tsconfig.app.json' }, { path: './tsconfig.test.json' }],
    });
  });

  test('the app project has no ambient types and no tests', () => {
    expect(compilerOptions('tsconfig.app.json')['types']).toEqual([]);
    // The OCR check's probe is browser code that imports the app's own
    // modules; it is outside `src/`, and went unchecked until a move broke
    // its imports and nothing noticed (#90).
    expect(json('tsconfig.app.json')['include']).toEqual(['src', 'scripts/ocr-check/probe.ts']);
    expect(json('tsconfig.app.json')['exclude']).toEqual(
      expect.arrayContaining(['src/**/*.test.ts', 'src/**/*.test.tsx', 'src/test']),
    );
  });

  test('the test project has the test and Node types', () => {
    expect(compilerOptions('tsconfig.test.json')['types']).toEqual(
      expect.arrayContaining(['vitest/globals', '@testing-library/jest-dom', 'node']),
    );
    expect(json('tsconfig.test.json')['extends']).toBe('./tsconfig.app.json');
  });

  test('typecheck and build check both projects', () => {
    // `tsc --noEmit` on a root with `files: []` checks nothing at all.
    const scripts = json('package.json')['scripts'] as Record<string, string>;
    expect(scripts['typecheck']).toBe('tsc -b');
    expect(scripts['build']).toBe('tsc -b && vite build');
  });

  /** Type-checks one file as app code; returns tsc's exit status and output. */
  function checkAsApp(source: string): { status: number | null; output: string } {
    const dir = mkdtempSync(join(tmpdir(), 'app-types-'));
    try {
      writeFileSync(join(dir, 'probe.ts'), source);
      writeFileSync(
        join(dir, 'tsconfig.json'),
        JSON.stringify({
          extends: join(process.cwd(), 'tsconfig.app.json'),
          compilerOptions: { tsBuildInfoFile: join(dir, 'probe.tsbuildinfo') },
          include: [],
          files: [join(dir, 'probe.ts')],
        }),
      );
      const run = spawnSync(join('node_modules', '.bin', 'tsc'), ['-p', join(dir, 'tsconfig.json')], {
        encoding: 'utf8',
      });
      return { status: run.status, output: `${run.stdout}${run.stderr}` };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test('app code that names describe, expect or process does not type-check', { timeout: 60_000 }, () => {
    const { status, output } = checkAsApp(
      'export const a = typeof describe;\nexport const b = typeof expect;\nexport const c = process.env;\n',
    );
    expect(status).not.toBe(0);
    expect(output).toMatch(/Cannot find name 'describe'/);
    expect(output).toMatch(/Cannot find name 'expect'/);
    expect(output).toMatch(/Cannot find name 'process'/);
  });

  test('while ordinary browser code does', { timeout: 60_000 }, () => {
    // The control: without it, a probe that fails for any reason at all — a
    // bad path, a missing binary — would pass the test above.
    expect(checkAsApp('export const title: string = document.title;\n')).toEqual({
      status: 0,
      output: '',
    });
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

describe('the index a shared car’s sync reads by (#66)', () => {
  test('firestore.indexes.json holds the composite index the member query needs', () => {
    // `where vehicleId == car` with `where syncedAt > mark`, in
    // firebase/sharingRemote.ts. Without it the read falls back to the whole
    // car — correct, just more reads — so it is declared here and deployed
    // once by hand (docs/deploying.md), keeping the deploy account's roles.
    const indexes = JSON.parse(readFileSync('firestore.indexes.json', 'utf8')) as {
      indexes: { collectionGroup: string; queryScope: string; fields: { fieldPath: string }[] }[];
    };
    const found = indexes.indexes.find(
      (index) =>
        index.collectionGroup === 'fillUps' &&
        index.queryScope === 'COLLECTION' &&
        index.fields.map((field) => field.fieldPath).join(',') === 'vehicleId,syncedAt',
    );
    expect(found).toBeDefined();
    const firebase = JSON.parse(readFileSync('firebase.json', 'utf8')) as { firestore: { indexes?: string } };
    expect(firebase.firestore.indexes).toBe('firestore.indexes.json');
  });
});
