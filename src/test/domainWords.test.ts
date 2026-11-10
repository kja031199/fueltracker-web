import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { sourcesUnder } from './imports';

/**
 * `domain/` says nothing in English (#94).
 *
 * The domain returns numbers, identifiers and unit symbols; the UI writes every
 * word a reader sees (`ui/words.ts`, `ui/wording.ts` and the phrasers beside
 * them). English built in `domain/` is English nothing can translate, and it
 * had leaked into sentences ("Total Spent", "trending up"), unit names
 * ("Gallons"), metric names and day names before #94 moved them out.
 *
 * This reads every string literal in `domain/` — comments are skipped, so the
 * prose explaining the code may say what it likes — and refuses one that
 * reads as English: a capitalised word, or two words in a row.
 *
 * `domain/scanning/` is exempt: it matches the English printed on US pumps and
 * receipts ("PER GAL", "CIRCLE K"), which is input it reads, not text it shows.
 */

/** Identifiers that look like words but are data, each with the reason. */
const IDENTIFIERS: ReadonlyMap<string, string> = new Map([
  // Fuel grades are stored as these strings (Swift's `fuelGradeRaw`), so they
  // cannot change; the UI shows them through `gradeLabel`.
  ['Regular', 'a stored fuel grade'],
  ['Midgrade', 'a stored fuel grade'],
  ['Premium', 'a stored fuel grade'],
  ['Diesel', 'a stored fuel grade'],
  ['Other', 'a stored fuel grade'],
  // The time ranges' ids, shared with the Swift; the UI shows `rangeLabel`.
  ['All', 'a time range id'],
]);

/** Reads as English: a capitalised word, or two words in a row. */
const ENGLISH = /\b[A-Z][a-z]{2,}\b|\b[A-Za-z]{2,}\s+[A-Za-z]{2,}\b/;

/**
 * The static text of every string literal in a TypeScript source: quoted
 * strings and the literal parts of template strings. Comments and regular
 * expression literals are skipped, the latter by the usual rule that a `/`
 * where a value may start begins a regex.
 */
export function stringLiterals(source: string): string[] {
  const found: string[] = [];
  let i = 0;
  // What came before, to tell a regex from a division.
  let previous = '';

  function quoted(quote: string): string {
    let text = '';
    i += 1;
    while (i < source.length && source[i] !== quote) {
      if (source[i] === '\\') {
        text += source[i + 1] ?? '';
        i += 2;
      } else {
        text += source[i];
        i += 1;
      }
    }
    i += 1;
    return text;
  }

  function template(): void {
    let text = '';
    i += 1;
    while (i < source.length && source[i] !== '`') {
      if (source[i] === '\\') {
        text += source[i + 1] ?? '';
        i += 2;
      } else if (source[i] === '$' && source[i + 1] === '{') {
        found.push(text);
        text = '';
        i += 2;
        code(1);
      } else {
        text += source[i];
        i += 1;
      }
    }
    found.push(text);
    i += 1;
  }

  function regex(): void {
    let inClass = false;
    i += 1;
    while (i < source.length) {
      const c = source[i];
      if (c === '\\') i += 2;
      else if (c === '[') {
        inClass = true;
        i += 1;
      } else if (c === ']') {
        inClass = false;
        i += 1;
      } else if (c === '/' && !inClass) {
        i += 1;
        break;
      } else if (c === '\n') break;
      else i += 1;
    }
    while (i < source.length && /[a-z]/.test(source[i]!)) i += 1;
  }

  /** Code, until the brace that closes `depth` (0: the end of the file). */
  function code(depth: number): void {
    let open = depth;
    while (i < source.length) {
      const c = source[i]!;
      const next = source[i + 1];
      if (c === '/' && next === '/') {
        while (i < source.length && source[i] !== '\n') i += 1;
      } else if (c === '/' && next === '*') {
        const end = source.indexOf('*/', i + 2);
        i = end === -1 ? source.length : end + 2;
      } else if (c === '/' && (previous === '' || /[(,=:[!&|?{};+\-*%<>~^]|return$/.test(previous))) {
        regex();
        previous = 'regex';
      } else if (c === "'" || c === '"') {
        found.push(quoted(c));
        previous = 'string';
      } else if (c === '`') {
        template();
        previous = 'string';
      } else if (c === '{') {
        open += 1;
        previous = c;
        i += 1;
      } else if (c === '}') {
        open -= 1;
        i += 1;
        previous = c;
        if (depth > 0 && open === 0) return;
      } else if (/\s/.test(c)) {
        i += 1;
      } else if (/[A-Za-z_$0-9]/.test(c)) {
        let word = '';
        while (i < source.length && /[A-Za-z_$0-9]/.test(source[i]!)) word += source[i++];
        previous = word === 'return' || word === 'typeof' ? 'return' : 'word';
      } else {
        previous = c;
        i += 1;
      }
    }
  }

  code(0);
  return found;
}

/** The literals in `source` that read as English and are not identifiers. */
export function englishIn(source: string): string[] {
  return stringLiterals(source).filter((text) => ENGLISH.test(text) && !IDENTIFIERS.has(text));
}

const DOMAIN = sourcesUnder('src/domain', false).filter((file) => !file.startsWith('src/domain/scanning/'));

describe('the literal reader', () => {
  test('finds strings, template parts and nested templates', () => {
    expect(stringLiterals(`const a = 'one'; const b = "two"; const c = \`x \${y ? \`in\` : 'z'} w\`;`)).toEqual([
      'one',
      'two',
      'x ',
      'in',
      'z',
      ' w',
    ]);
  });

  test('skips comments and regular expressions, but not division', () => {
    const source = [
      "// 'Fuel economy' in a comment",
      "/* \"Gas price\" in a block */",
      "const pattern = /'Total Spent'/g;",
      "const test = (x: string) => /[A-Z]{3}'/.test(x);",
      "const half = total / 2; const label = 'Kept';",
      'if (ok) return /a"b/;',
    ].join('\n');
    expect(stringLiterals(source)).toEqual(['Kept']);
  });

  test('reads escapes without ending the string early', () => {
    expect(stringLiterals(String.raw`const a = 'it\'s'; const b = "a\"b";`)).toEqual(["it's", 'a"b']);
  });
});

describe('what counts as English', () => {
  test.each([
    "const NAME = 'Fuel economy';",
    "return 'Invalid Date';",
    "const name = 'Gallons';",
    'const title = `Total ${n} spent`;',
    "const days = ['Sunday', 'Monday'];",
    'const s = "trending up";',
  ])('catches %s', (source) => {
    expect(englishIn(source)).not.toEqual([]);
  });

  test.each([
    "import { x } from './fuelGrade';",
    "const id = 'avgEconomy';",
    "const unit = { abbreviation: 'L/100km' };",
    "const sym = 'MPG'; const km = 'km/L'; const mi = 'mi'; const gal = 'gal';",
    "const grade = 'Regular';",
    "const range = 'All';",
    "const dash = '—';",
    "const tag = 'en-US';",
    '// Total Spent, in a comment',
  ])('lets %s through', (source) => {
    expect(englishIn(source)).toEqual([]);
  });
});

describe('domain/ (#94)', () => {
  test('reads some files, so a clean result means something', () => {
    expect(DOMAIN.length).toBeGreaterThan(10);
    expect(DOMAIN).toContain('src/domain/units.ts');
  });

  test.each(DOMAIN)('%s has no English in its strings', (file) => {
    expect(englishIn(readFileSync(file, 'utf8'))).toEqual([]);
  });
});
