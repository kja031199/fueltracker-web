/**
 * Re-runs the recorded mutations (#98).
 *
 * A test is only worth keeping if it fails when the thing it guards breaks,
 * and the way to know is to break it on purpose. Every mutation in
 * `scripts/mutations/sets/*.json` names a file, an exact piece of text in it
 * and what to put there instead. This applies one, runs the tests, requires
 * them to fail, and puts the file back — always, even on Ctrl-C.
 *
 *   npm run mutate                  every mutation, inside one Firestore emulator
 *   npm run mutate -- sync 079      only the sets or mutations those words name
 *   npm run mutate:check            no tests run: does every mutation still apply?
 *
 * A mutation that survives fails the run, unless it is recorded with
 * `survives` and the reason it is equivalent. `src/test/mutations.test.ts`
 * runs the check on every pull request, so a refactor that moves the code a
 * mutation breaks has to move the mutation too.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface Mutation {
  /** What it breaks, as a sentence fragment: "the allowlist dropped from owner()". */
  readonly name: string;
  /** The file it changes, from the repository root. */
  readonly file: string;
  /** The exact text to replace, which must occur once. Absent: the whole file. */
  readonly from?: string;
  /** What to put there instead. */
  readonly to: string;
  /** The tests that should catch it. Absent: the set's, or the whole suite. */
  readonly tests?: readonly string[];
  /** Recorded as surviving, with the reason it is equivalent. */
  readonly survives?: string;
}

export interface MutationSet {
  /** Where it was read from. */
  readonly file: string;
  /** "#79 Merge stamp". */
  readonly title: string;
  /** The tests for every mutation in it that names none of its own. */
  readonly tests?: readonly string[];
  readonly mutations: readonly Mutation[];
}

export const SETS_DIR = 'scripts/mutations/sets';

/** Every set, in file-name order. */
export function loadSets(dir: string = SETS_DIR): MutationSet[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const path = join(dir, name).replaceAll('\\', '/');
      return { ...(JSON.parse(readFileSync(path, 'utf8')) as Omit<MutationSet, 'file'>), file: path };
    });
}

const readText = (file: string): string => readFileSync(file, 'utf8');

/**
 * What is wrong with one mutation, against the code as it is now, or `null`.
 * Text that no longer occurs exactly once is stale: the code moved on, and
 * the record has to follow it.
 */
export function problemWith(
  mutation: Mutation,
  read: (file: string) => string = readText,
  exists: (path: string) => boolean = existsSync,
): string | null {
  if (typeof mutation.name !== 'string' || mutation.name.trim() === '') return 'has no name';
  if (typeof mutation.file !== 'string' || mutation.file === '') return 'names no file';
  if (typeof mutation.to !== 'string') return 'has no replacement';
  if (mutation.survives !== undefined && (typeof mutation.survives !== 'string' || mutation.survives.trim() === '')) {
    return 'is recorded as surviving but never says why';
  }
  const gone = missingTests(mutation.tests, exists);
  if (gone.length > 0) return `names tests that do not exist: ${gone.join(', ')}`;
  let source: string;
  try {
    source = read(mutation.file);
  } catch {
    return `${mutation.file} does not exist`;
  }
  if (mutation.from === undefined) return mutation.to === source ? 'changes nothing' : null;
  if (typeof mutation.from !== 'string' || mutation.from === '') return 'has no text to replace';
  if (mutation.from === mutation.to) return 'changes nothing';
  const count = source.split(mutation.from).length - 1;
  if (count === 0) return `its text is no longer in ${mutation.file}`;
  if (count > 1) return `its text occurs ${count} times in ${mutation.file}`;
  return null;
}

/**
 * The test paths a `tests` list names that do not exist. A renamed test file
 * left in a list is not an error to vitest, which runs the rest — so the test
 * that would have caught the mutation silently stops running; and a list that
 * names only missing files makes vitest exit non-zero with nothing run, which
 * would read as a kill.
 */
export function missingTests(
  tests: readonly string[] | undefined,
  exists: (path: string) => boolean = existsSync,
): string[] {
  if (tests === undefined) return [];
  const missing: string[] = [];
  for (let i = 0; i < tests.length; i += 1) {
    const word = tests[i]!;
    if (word === '--project') {
      i += 1;
      continue;
    }
    if (word.startsWith('--')) continue;
    if (!exists(word)) missing.push(word);
  }
  return missing;
}

/** What is wrong with a set as a whole, or `null`. */
export function problemWithSet(set: MutationSet, exists: (path: string) => boolean = existsSync): string | null {
  if (typeof set.title !== 'string' || set.title.trim() === '') return 'has no title';
  const gone = missingTests(set.tests, exists);
  if (gone.length > 0) return `names tests that do not exist: ${gone.join(', ')}`;
  if (!Array.isArray(set.mutations) || set.mutations.length === 0) return 'has no mutations';
  const names = set.mutations.map((mutation) => mutation.name);
  const twice = names.find((name, index) => names.indexOf(name) !== index);
  return twice === undefined ? null : `names "${twice}" twice`;
}

/** The file's text with the mutation applied. The replacement is literal: `$&` stays `$&`. */
export function applied(source: string, mutation: Mutation): string {
  return mutation.from === undefined ? mutation.to : source.replace(mutation.from, () => mutation.to);
}

/**
 * The record's own check (`src/test/mutations.test.ts`), which fails for
 * *every* applied mutation — a mutated file no longer holds its `from`. Left
 * in a mutation's run, it "kills" every mutation, whatever the real tests do.
 */
export const OWN_CHECK = 'src/test/mutations.test.ts';

/** How one mutation is tested: its tests, its set's, or the suite — stopping at the first failure. */
export function testCommand(set: MutationSet, mutation: Mutation): string[] {
  const tests =
    mutation.tests ??
    set.tests ??
    (mutation.file === 'firestore.rules' ? ['--project', 'rules'] : ['--project', 'unit', '--project', 'dom']);
  return ['npx', 'vitest', 'run', '--bail', '1', '--exclude', OWN_CHECK, ...tests];
}

/**
 * Whether a mutation's tests read the built app: the `build` project, or a
 * `*.build.test.ts` named outright. Those refuse to start without `dist/`, and
 * a refusal exits non-zero — so without a build every such mutation would
 * read as killed. The run checks for one first (#99).
 */
export function needsBuild(command: readonly string[]): boolean {
  return command.some(
    (word, i) => (word === 'build' && command[i - 1] === '--project') || /\.build\.test\.tsx?$/.test(word),
  );
}

/** Whether the words on the command line ask for this mutation. None asks for all. */
export function wanted(words: readonly string[], set: MutationSet, mutation: Mutation): boolean {
  if (words.length === 0) return true;
  const haystack = `${set.file} ${set.title} ${mutation.name}`.toLowerCase();
  return words.some((word) => haystack.includes(word.toLowerCase()));
}

/** The pinned Firebase CLI, as `npm run test:rules` uses it. */
export const FIREBASE = '.github/firebase-cli/node_modules/.bin/firebase';

/** A word for `sh -c`, quoted so nothing in it is read as shell. */
export function shellQuoted(word: string): string {
  return `'${word.replaceAll("'", "'\\''")}'`;
}

/**
 * This run again, inside one Firestore emulator. The rules tests read
 * `firestore.rules` from disk for each environment they make, so one emulator
 * serves every mutation of the rules, and the words on the command line reach
 * the runner rather than the Firebase CLI.
 *
 * Started from `scripts/mutations/firebase.json`, which names **no rules
 * file**: with the real config the emulator watches `firestore.rules`, and
 * reloading it on the first mutation took the emulator down — after which
 * every rules mutation "failed" in a second, against nothing.
 */
export function insideEmulator(argv: readonly string[]): string[] {
  const inner = [process.execPath, '--experimental-strip-types', 'scripts/mutations/mutate.ts', ...argv]
    .map(shellQuoted)
    .join(' ');
  return [
    FIREBASE,
    'emulators:exec',
    '--config',
    'scripts/mutations/firebase.json',
    '--only',
    'firestore',
    '--project',
    'fueltracker-rules-test',
    inner,
  ];
}

/**
 * Where the original of a file being mutated is kept until it is put back.
 * A run killed outright — no `finally`, no signal handler — leaves it here,
 * and the next run puts it back before doing anything else.
 */
export const RESTORE_DIR = 'scripts/mutations/.restore';

function keep(file: string, original: string): string {
  mkdirSync(RESTORE_DIR, { recursive: true });
  const kept = join(RESTORE_DIR, encodeURIComponent(file));
  writeFileSync(kept, original);
  return kept;
}

/** Puts back whatever an interrupted run left mutated; returns what it restored. */
export function recoverInterrupted(dir: string = RESTORE_DIR): string[] {
  if (!existsSync(dir)) return [];
  const restored = readdirSync(dir).map((name) => {
    const file = decodeURIComponent(name);
    writeFileSync(file, readFileSync(join(dir, name)));
    return file;
  });
  rmSync(dir, { recursive: true, force: true });
  return restored;
}

/** Whether the emulator at `host:port` is accepting connections. */
export function reachable(hostAndPort: string, timeoutMs = 3000): Promise<boolean> {
  const colon = hostAndPort.lastIndexOf(':');
  const host = hostAndPort.slice(0, colon);
  const port = Number(hostAndPort.slice(colon + 1));
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** Runs the tests; resolves with the exit status. Asynchronous, so a signal is heard mid-run. */
function runTests(command: readonly string[]): Promise<number> {
  const [program, ...args] = command;
  return new Promise((resolve) => {
    const child = spawn(program!, args, { stdio: 'ignore', env: { ...process.env, CI: 'true' } });
    child.once('error', () => resolve(1));
    child.once('exit', (code) => resolve(code ?? 1));
  });
}

interface Outcome {
  readonly set: string;
  readonly name: string;
  readonly verdict: string;
  readonly ok: boolean;
}

async function main(argv: readonly string[]): Promise<number> {
  const recovered = recoverInterrupted();
  if (recovered.length > 0) console.log(`Put back from an interrupted run: ${recovered.join(', ')}`);

  const checkOnly = argv.includes('--check');
  const words = argv.filter((arg) => !arg.startsWith('--'));
  const sets = loadSets();

  const problems = sets.flatMap((set) => {
    const ofSet = problemWithSet(set);
    return [
      ...(ofSet === null ? [] : [`${set.file} ${ofSet}`]),
      ...set.mutations.flatMap((mutation) => {
        const problem = problemWith(mutation);
        return problem === null ? [] : [`${set.file}: "${mutation.name}" ${problem}`];
      }),
    ];
  });
  if (problems.length > 0) {
    console.error(`The record is stale; update it before running:\n  ${problems.join('\n  ')}`);
    return 1;
  }
  const total = sets.reduce((sum, set) => sum + set.mutations.length, 0);
  if (checkOnly) {
    console.log(`${total} mutations in ${sets.length} sets, every one still applies.`);
    return 0;
  }

  const emulator = process.env['FIRESTORE_EMULATOR_HOST'];
  if (emulator === undefined || emulator.trim() === '') {
    const [command, ...args] = insideEmulator(argv);
    return spawnSync(command!, args, { stdio: 'inherit' }).status ?? 1;
  }

  const needingBuild = sets.flatMap((set) =>
    set.mutations.filter((mutation) => wanted(words, set, mutation) && needsBuild(testCommand(set, mutation))),
  );
  if (needingBuild.length > 0 && !existsSync('dist/index.html')) {
    console.error(
      `${needingBuild.length} of these mutations are tested against the build, and there is none: run \`npm run build\` first.`,
    );
    return 1;
  }

  // Whatever is mutated is put back, however the run ends.
  let restore: (() => void) | null = null;
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      restore?.();
      process.exit(130);
    });
  }

  const outcomes: Outcome[] = [];
  for (const set of sets) {
    for (const mutation of set.mutations) {
      if (!wanted(words, set, mutation)) continue;
      // A dead emulator fails every rules test, which would read as every
      // rules mutation killed. Checked before and after, so it never does.
      if (!(await reachable(emulator))) {
        console.error(`The Firestore emulator at ${emulator} is not answering; stopping rather than guessing.`);
        return 1;
      }
      const original = readFileSync(mutation.file, 'utf8');
      const kept = keep(mutation.file, original);
      restore = () => {
        writeFileSync(mutation.file, original);
        rmSync(kept, { force: true });
      };
      const started = Date.now();
      let status: number;
      try {
        writeFileSync(mutation.file, applied(original, mutation));
        status = await runTests(testCommand(set, mutation));
      } finally {
        restore();
        restore = null;
      }
      if (!(await reachable(emulator))) {
        console.error(`The Firestore emulator stopped answering during "${mutation.name}"; its result is not counted.`);
        return 1;
      }
      const killed = status !== 0;
      const recorded = mutation.survives !== undefined;
      const verdict = killed
        ? recorded
          ? 'killed — recorded as surviving, so take its `survives` off'
          : 'killed'
        : recorded
          ? `survives, as recorded: ${mutation.survives}`
          : 'SURVIVED';
      const outcome = { set: set.title, name: mutation.name, verdict, ok: killed || recorded };
      outcomes.push(outcome);
      const seconds = Math.round((Date.now() - started) / 1000);
      console.log(`${outcome.ok ? '✓' : '✗'} ${set.title}: ${mutation.name} — ${verdict} (${seconds}s)`);
    }
  }
  rmSync(RESTORE_DIR, { recursive: true, force: true });

  const failed = outcomes.filter((outcome) => !outcome.ok);
  const lines = [
    '## Mutation testing',
    '',
    `${outcomes.length} mutations run: ${outcomes.length - failed.length} killed or recorded as equivalent, ${failed.length} surviving.`,
    '',
    ...(failed.length === 0
      ? []
      : ['| Set | Surviving mutation |', '|---|---|', ...failed.map((row) => `| ${row.set} | ${row.name} |`), '']),
  ];
  const summary = lines.join('\n');
  console.log(`\n${summary}`);
  const stepSummary = process.env['GITHUB_STEP_SUMMARY'];
  if (stepSummary !== undefined && stepSummary !== '') appendFileSync(stepSummary, `${summary}\n`);
  return failed.length === 0 && outcomes.length > 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
