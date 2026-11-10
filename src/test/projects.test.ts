import { readFileSync, readdirSync } from 'node:fs';
import { join, matchesGlob } from 'node:path';
import { describe, expect, test } from 'vitest';
import config from '../../vite.config';
import { buildMissing, emulatorMissing, prerequisiteError } from './prerequisites';

/**
 * Which tests run where (#97).
 *
 * The suite is three groups, as Vitest projects:
 *
 * - **unit**, `npm test`: everything that needs nothing but Node.
 * - **rules**, `npm run test:rules`: the `*.emulator.test.ts` files, run
 *   against the real `firestore.rules` on the Firestore emulator.
 * - **build**, `npm run test:build`: the `*.build.test.ts` files, which read
 *   the built site in `dist/`. The script builds first, so they never check a
 *   stale build.
 *
 * Before this, they were one run. Every normal run reported the 84 emulator
 * tests as skipped, `csp.test.ts` failed on a fresh clone while the other two
 * `dist/` readers skipped, and the CI rules job ran a whole directory, pure
 * tests included. A group is now chosen by the file's **name**, and this file
 * holds the names to what the tests actually need.
 */

interface ProjectTest {
  readonly name: string;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly globalSetup: readonly string[];
}

function projects(): ProjectTest[] {
  const listed = (config.test?.projects ?? []) as readonly {
    readonly test?: {
      readonly name?: string;
      readonly include?: readonly string[];
      readonly exclude?: readonly string[];
      readonly globalSetup?: string | readonly string[];
    };
  }[];
  return listed.map(({ test: project = {} }) => ({
    name: project.name ?? '',
    include: project.include ?? [],
    exclude: project.exclude ?? [],
    globalSetup:
      project.globalSetup === undefined
        ? []
        : typeof project.globalSetup === 'string'
          ? [project.globalSetup]
          : project.globalSetup,
  }));
}

function testFiles(dir = 'src'): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return testFiles(path);
    return /\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** The projects that would run `file`: it matches an include and no exclude. */
function projectsOf(file: string): string[] {
  return projects()
    .filter(
      ({ include, exclude }) =>
        include.some((glob) => matchesGlob(file, glob)) &&
        !exclude.some((glob) => matchesGlob(file, glob)),
    )
    .map(({ name }) => name);
}

/** Imports the emulator setup. */
const USES_EMULATOR = /from '(?:\.\.\/)+test\/emulator'|from '\.\/emulator'/;
/** Reads the build output: a quoted `dist` path segment, as `'dist/…'` or `'dist'`. */
const READS_BUILD = /['"`]dist['"`/]/;
const THIS_FILE = join('src', 'test', 'projects.test.ts');

describe('the three test projects', () => {
  test('are unit, rules and build', () => {
    expect(projects().map(({ name }) => name)).toEqual(['unit', 'rules', 'build']);
  });

  test('there are test files to check, so a passing suite means something', () => {
    expect(testFiles().length).toBeGreaterThan(100);
  });

  test.each(testFiles())('%s runs in exactly one project', (file) => {
    // None: the file never runs. Two: it runs twice, which is what the rules
    // job did to every pure test under src/data/firebase/.
    expect(projectsOf(file)).toHaveLength(1);
  });

  test('a file is classified by its name', () => {
    expect(projectsOf('src/data/firebase/rules.emulator.test.ts')).toEqual(['rules']);
    expect(projectsOf('src/ui/csp.build.test.ts')).toEqual(['build']);
    expect(projectsOf('src/ui/App.test.tsx')).toEqual(['unit']);
    expect(projectsOf('src/data/firebase/settings.test.ts')).toEqual(['unit']);
  });

  test('only the rules and build projects have prerequisites', () => {
    // `npm test` must work on a fresh clone with nothing running.
    const setup = Object.fromEntries(projects().map(({ name, globalSetup }) => [name, globalSetup]));
    expect(setup.unit).toEqual([]);
    expect(setup.rules).toEqual(['src/test/needsEmulator.ts']);
    expect(setup.build).toEqual(['src/test/needsBuild.ts']);
  });
});

describe('a test file is named for what it needs', () => {
  const sources = testFiles()
    .filter((file) => file !== THIS_FILE)
    .map((file) => ({ file, text: readFileSync(file, 'utf8') }));

  test('the detectors find the files they are meant to', () => {
    // Guards the guard: a pattern that matched nothing would report every
    // file correctly named for ever.
    expect(sources.filter(({ text }) => USES_EMULATOR.test(text)).length).toBeGreaterThanOrEqual(3);
    expect(sources.filter(({ text }) => READS_BUILD.test(text)).length).toBeGreaterThanOrEqual(3);
    expect(USES_EMULATOR.test("} from '../../test/emulator';")).toBe(true);
    expect(READS_BUILD.test("readFileSync('dist/index.html')")).toBe(true);
    expect(READS_BUILD.test("join(process.cwd(), 'dist', name)")).toBe(true);
    // A package's own dist folder is not the build.
    expect(READS_BUILD.test("require.resolve('tesseract.js/dist/worker.min.js')")).toBe(false);
  });

  test.each(sources.map(({ file }) => file))('%s', (file) => {
    const text = sources.find((source) => source.file === file)?.text ?? '';
    // Both directions: a file that needs the emulator but is named as a unit
    // test would run in `npm test` and fail there, and a `.emulator.test.ts`
    // that never touches the emulator is a pure test hiding in the rules job.
    expect(USES_EMULATOR.test(text), 'imports the emulator setup').toBe(
      file.includes('.emulator.test.'),
    );
    expect(READS_BUILD.test(text), 'reads the build in dist/').toBe(file.includes('.build.test.'));
  });
});

describe('the npm scripts run one project each', () => {
  const scripts = (
    JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }
  ).scripts;

  test('npm test runs the unit project, and needs nothing running', () => {
    expect(scripts.test).toBe('vitest run --project unit');
    expect(scripts['test:watch']).toBe('vitest --project unit');
  });

  test('test:build builds first, so it never reads a stale dist/', () => {
    expect(scripts['test:build']).toBe('vite build && vitest run --project build');
  });

  test('test:rules runs the rules project inside the pinned emulator', () => {
    const rules = scripts['test:rules'] ?? '';
    // The pinned CLI, the same one CI and the deploy run (#30).
    expect(rules).toMatch(/^\.github\/firebase-cli\/node_modules\/\.bin\/firebase emulators:exec /);
    expect(rules).toMatch(/--only firestore\b/);
    expect(rules).toMatch(/--project fueltracker-rules-test\b/);
    expect(rules).toMatch(/"vitest run --project rules"$/);
  });
});

describe('a project that cannot run says why, instead of skipping', () => {
  test('the emulator is missing when its host is unset or blank', () => {
    expect(emulatorMissing({})).toMatch(/npm run test:rules/);
    expect(emulatorMissing({ FIRESTORE_EMULATOR_HOST: '' })).toMatch(/npm run test:rules/);
    expect(emulatorMissing({ FIRESTORE_EMULATOR_HOST: '   ' })).toMatch(/npm run test:rules/);
    expect(emulatorMissing({ FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' })).toBeNull();
  });

  test('the build is missing without dist/index.html', () => {
    expect(buildMissing(() => false)).toMatch(/npm run test:build/);
    const asked: string[] = [];
    expect(
      buildMissing((path) => {
        asked.push(path);
        return true;
      }),
    ).toBeNull();
    expect(asked).toEqual([join('dist', 'index.html')]);
  });

  test('the error carries its reason as its stack, so Vitest prints the reason', () => {
    // Vitest 5 crashed source-mapping a global setup's stack and printed the
    // crash instead of the message. A string stack is never mapped.
    const error = prerequisiteError('why it stopped');
    expect(error.message).toBe('why it stopped');
    expect(error.stack).toBe('why it stopped');
  });
});
