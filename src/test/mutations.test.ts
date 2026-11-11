import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  FIREBASE,
  OWN_CHECK,
  applied,
  insideEmulator,
  reachable,
  recoverInterrupted,
  loadSets,
  missingTests,
  problemWith,
  problemWithSet,
  shellQuoted,
  testCommand,
  wanted,
  type Mutation,
  type MutationSet,
} from '../../scripts/mutations/mutate';

/**
 * The recorded mutations still apply to the code as it is (#98).
 *
 * `npm run mutate` re-runs every mutation in `scripts/mutations/sets/` and
 * fails if a test stops killing one — weekly in CI, and on demand. That run
 * takes an hour; this takes a second, on every pull request: each mutation's
 * text must still occur exactly once in its file. A refactor that moves the
 * code a mutation breaks therefore fails here, at once, and the record moves
 * with the code instead of rotting until the weekly run trips over it.
 */

const file = (text: string) => (name: string) => {
  if (name !== 'src/a.ts') throw new Error('no such file');
  return text;
};

const mutation = (overrides: Partial<Mutation> = {}): Mutation => ({
  name: 'a check removed',
  file: 'src/a.ts',
  from: 'if (bad) throw',
  to: 'if (false) throw',
  ...overrides,
});

const set = (overrides: Partial<MutationSet> = {}): MutationSet => ({
  file: 'scripts/mutations/sets/001-a.json',
  title: '#1 A',
  mutations: [mutation()],
  ...overrides,
});

describe('a recorded mutation', () => {
  const source = 'const x = 1;\nif (bad) throw new Error();\n';

  test('applies when its text occurs exactly once', () => {
    expect(problemWith(mutation(), file(source))).toBeNull();
    expect(applied(source, mutation())).toBe('const x = 1;\nif (false) throw new Error();\n');
  });

  test('is stale once its text has gone, or occurs twice', () => {
    expect(problemWith(mutation({ from: 'if (worse) throw' }), file(source))).toMatch(/no longer in src\/a\.ts/);
    expect(problemWith(mutation(), file(source + source))).toMatch(/occurs 2 times/);
  });

  test('names a file that exists', () => {
    expect(problemWith(mutation({ file: 'src/gone.ts' }), file(source))).toMatch(/does not exist/);
  });

  test.each([
    ['no name', { name: '  ' }, /no name/],
    ['no replacement', { to: undefined as unknown as string }, /no replacement/],
    ['an empty text to find', { from: '' }, /no text to replace/],
    ['a replacement that changes nothing', { to: 'if (bad) throw' }, /changes nothing/],
    ['a survivor with no reason', { survives: '' }, /says why/],
  ] as const)('is refused with %s', (_label, overrides, problem) => {
    expect(problemWith(mutation(overrides), file(source))).toMatch(problem);
  });

  test('without `from` replaces the whole file', () => {
    const { from: _from, ...rest } = mutation({ to: 'everything else' });
    const whole: Mutation = rest;
    expect(problemWith(whole, file(source))).toBeNull();
    expect(applied(source, whole)).toBe('everything else');
  });

  test('a replacement with `$` in it is taken literally', () => {
    // `String.replace` reads `$&` and `$1` in a replacement string; rules and
    // regexes are full of `$(`.
    const dollar = mutation({ to: 'if ($&) $1 throw' });
    expect(applied(source, dollar)).toContain('if ($&) $1 throw');
  });
});

describe('the tests a mutation names', () => {
  const exists = (path: string) => path === 'src/a.test.ts' || path === 'src/data/';

  test('must exist: a renamed test file stops running without a word', () => {
    expect(missingTests(['src/a.test.ts', 'src/data/'], exists)).toEqual([]);
    expect(missingTests(['src/a.test.ts', 'src/data/firebase/sharing.test.ts'], exists)).toEqual([
      'src/data/firebase/sharing.test.ts',
    ]);
    expect(missingTests(undefined, exists)).toEqual([]);
  });

  test('flags and a project name are not paths', () => {
    expect(missingTests(['--project', 'rules', '--project', 'build', 'src/a.test.ts'], exists)).toEqual([]);
  });

  test('a mutation or a set naming one is stale', () => {
    const source = 'if (bad) throw';
    expect(problemWith(mutation({ tests: ['src/gone.test.ts'] }), file(source), exists)).toMatch(
      /do not exist: src\/gone\.test\.ts/,
    );
    expect(problemWithSet(set({ tests: ['src/gone.test.ts'] }), exists)).toMatch(/do not exist/);
  });
});

describe('a set', () => {
  test('needs a title and at least one mutation', () => {
    expect(problemWithSet(set())).toBeNull();
    expect(problemWithSet(set({ title: '' }))).toMatch(/title/);
    expect(problemWithSet(set({ mutations: [] }))).toMatch(/no mutations/);
  });

  test('names each mutation once', () => {
    expect(problemWithSet(set({ mutations: [mutation(), mutation()] }))).toMatch(/twice/);
  });
});

describe('the command a mutation is tested by', () => {
  test('is its own tests, then its set’s, stopping at the first failure', () => {
    expect(testCommand(set(), mutation({ tests: ['src/a.test.ts'] }))).toEqual([
      'npx',
      'vitest',
      'run',
      '--bail',
      '1',
      '--exclude',
      OWN_CHECK,
      'src/a.test.ts',
    ]);
    expect(testCommand(set({ tests: ['src/b.test.ts'] }), mutation())).toEqual([
      'npx',
      'vitest',
      'run',
      '--bail',
      '1',
      '--exclude',
      OWN_CHECK,
      'src/b.test.ts',
    ]);
  });

  test('is the rules project for the rules, and the main suite otherwise', () => {
    expect(testCommand(set(), mutation({ file: 'firestore.rules' }))).toEqual([
      'npx',
      'vitest',
      'run',
      '--bail',
      '1',
      '--exclude',
      OWN_CHECK,
      '--project',
      'rules',
    ]);
    expect(testCommand(set(), mutation())).toEqual([
      'npx',
      'vitest',
      'run',
      '--bail',
      '1',
      '--exclude',
      OWN_CHECK,
      '--project',
      'unit',
      '--project',
      'dom',
    ]);
  });

  test('never includes this file, which fails for every mutation applied', () => {
    // A mutated file no longer holds its own `from`, so the check above goes
    // red for every mutation. Run with the suite, it "killed" every one.
    expect(OWN_CHECK).toBe('src/test/mutations.test.ts');
    expect(testCommand(set(), mutation()).join(' ')).toContain(`--exclude ${OWN_CHECK}`);
  });
});

describe('the emulator around the run', () => {
  test('is the pinned CLI, with the words passed to the runner inside it', () => {
    const [cli, ...args] = insideEmulator(['sync', '--check']);
    expect(cli).toBe(FIREBASE);
    expect(args.slice(0, -1)).toEqual([
      'emulators:exec',
      '--config',
      'scripts/mutations/firebase.json',
      '--only',
      'firestore',
      '--project',
      'fueltracker-rules-test',
    ]);
    expect(args.at(-1)).toMatch(/'scripts\/mutations\/mutate\.ts' 'sync' '--check'$/);
  });

  test('watches no rules file, so mutating the rules cannot take it down', () => {
    // The tests load `firestore.rules` themselves; an emulator that also
    // watched it reloaded on the first mutation and died.
    const config = JSON.parse(readFileSync('scripts/mutations/firebase.json', 'utf8')) as Record<string, unknown>;
    expect(config).not.toHaveProperty('firestore');
    expect(config).toHaveProperty('emulators.firestore.port');
  });

  test('is checked for life: a closed port is not an emulator', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    expect(await reachable(`127.0.0.1:${port}`)).toBe(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await reachable(`127.0.0.1:${port}`, 500)).toBe(false);
  });

  test('quotes a word so the shell reads none of it', () => {
    expect(shellQuoted("it's $(rm -rf) `x`")).toBe(`'it'\\''s $(rm -rf) \`x\`'`);
  });
});

describe('an interrupted run', () => {
  test('is put back by the next one, and the copies are cleared', () => {
    const root = mkdtempSync(join(tmpdir(), 'mutate-'));
    const target = join(root, 'a.ts');
    writeFileSync(target, 'mutated');
    const kept = join(root, '.restore');
    mkdirSync(kept);
    writeFileSync(join(kept, encodeURIComponent(target)), 'original');

    expect(recoverInterrupted(kept)).toEqual([target]);
    expect(readFileSync(target, 'utf8')).toBe('original');
    expect(existsSync(kept)).toBe(false);
  });

  test('with nothing left over, there is nothing to do', () => {
    expect(recoverInterrupted(join(tmpdir(), 'mutate-nothing-here'))).toEqual([]);
  });
});

describe('choosing which to run', () => {
  test('no words runs everything; words match the set or the mutation', () => {
    expect(wanted([], set(), mutation())).toBe(true);
    expect(wanted(['001'], set(), mutation())).toBe(true);
    expect(wanted(['#1 a'], set(), mutation())).toBe(true);
    expect(wanted(['CHECK REMOVED'], set(), mutation())).toBe(true);
    expect(wanted(['rules'], set(), mutation())).toBe(false);
  });
});

describe('the record (#98)', () => {
  const sets = loadSets();

  test('there is one, so a clean result means something', () => {
    expect(sets.length).toBeGreaterThan(30);
    expect(sets.reduce((sum, each) => sum + each.mutations.length, 0)).toBeGreaterThan(300);
    // The rules are the security boundary: they must be in it.
    expect(sets.some((each) => each.mutations.some((m) => m.file === 'firestore.rules'))).toBe(true);
  });

  test.each(sets.map((each) => [each.file, each] as const))('%s is well formed', (_name, each) => {
    expect(problemWithSet(each)).toBeNull();
  });

  test.each(sets.flatMap((each) => each.mutations.map((m) => [`${each.title}: ${m.name}`, m] as const)))(
    '%s still applies',
    (_name, each) => {
      expect(problemWith(each)).toBeNull();
    },
  );
});
