import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { sourcesUnder } from './imports';

/**
 * One copy of each pattern the screens share (#93).
 *
 * The confirm-then-act pair, the screen frame, the clipboard handling and a
 * person's display name had two to nine copies each, and copies drift: five
 * frames put the title inside `<main>` and two outside it; one clipboard copy
 * checked for a missing clipboard differently from the other. Each now has a
 * home, and this refuses another copy anywhere else.
 */

interface Rule {
  readonly name: string;
  readonly home: string | null;
  readonly pattern: RegExp;
  /** Copies the pattern must catch, so a clean result means something. */
  readonly planted: readonly string[];
  /** Look-alikes it must not catch. */
  readonly innocent: readonly string[];
}

const RULES: readonly Rule[] = [
  {
    name: 'the screen frame',
    home: 'src/ui/ScreenFrame.tsx',
    pattern: /className=["']app["']/,
    planted: ['<div className="app">', "<div className='app'>"],
    innocent: ['<div className="app__main">', '<h1 className="app__title">'],
  },
  {
    name: 'the clipboard',
    home: 'src/ui/useCopyToClipboard.ts',
    pattern: /navigator\.clipboard/,
    planted: ['await navigator.clipboard.writeText(url);', 'if (navigator.clipboard === undefined)'],
    innocent: ['const { copy } = useCopyToClipboard();'],
  },
  {
    name: 'a person’s display name',
    home: null,
    pattern: /\.name\s*\|\|\s*[\w.]*\.email/,
    planted: ['{member.name || member.email}', 'shown.set(member.uid, member.name||member.email)'],
    innocent: ['displayName(member)', 'row.submitterName || "someone"'],
  },
  {
    // #94: one display locale for numbers and dates. A date in the browser's
    // default locale (`toLocaleDateString()`), or anything pinned to US
    // English, disagrees with the numbers beside it; both go through
    // `format.ts`, which is the only place the default is spelled.
    name: 'a fixed or default display locale',
    home: 'src/domain/format.ts',
    pattern: /\btoLocale(?:Date|Time)?String\(|['"]en-US['"]/,
    planted: [
      'title={new Date(record.date).toLocaleDateString()}',
      "const MONTH = new Intl.DateTimeFormat('en-US', { month: 'narrow' });",
      'label: point.date.toLocaleString(),',
      'numberFormat("en-US", {})',
    ],
    innocent: ['title={formatDate(record.date, locale)}', 'options.locale ?? US_STYLE.locale', "lang: 'en-GB'"],
  },
  {
    // #94: "row(s)" is a shrug at the reader, and a hand-rolled
    // `n === 1 ? '' : 's'` is how English plural rules get written down wrong
    // once per sentence. Counts go through `countOf` in `format.ts`.
    name: 'a hand-written plural',
    home: null,
    pattern: /[a-z]\(s\)|===\s*1\s*\?\s*['"`]/,
    planted: [
      '`${n} row(s) were skipped`',
      "`${n} minute${n === 1 ? '' : 's'} ago`",
      "{size === 1 ? ' looks' : 's look'}",
      '`${tooNew === 1 ? "1 row was" : "rows"}`',
    ],
    innocent: [
      "fillUps.map((r) => r.station).filter((s) => s !== '')",
      'sorted.length % 2 === 1 ? sorted[middle]! : 0',
      "countOf(n, { one: '# row was', other: '# rows were' })",
    ],
  },
  {
    name: 'the confirm-then-act pair',
    // `ConfirmButton` takes its labels as props, so no file should hold a
    // hand-written Keep or Stay button.
    home: null,
    pattern: />\s*(Keep|Stay)\s*</,
    planted: ['        >\n          Keep\n        </button>', '<button>Stay</button>'],
    innocent: ['cancelLabel="Keep"', "cancelLabel: 'Stay'"],
  },
];

const PRODUCTION = sourcesUnder('src', false);

describe.each(RULES)('one copy of $name', (rule) => {
  test('the check catches a copy and passes a look-alike', () => {
    for (const source of rule.planted) expect(rule.pattern.test(source), source).toBe(true);
    for (const source of rule.innocent) expect(rule.pattern.test(source), source).toBe(false);
  });

  test('its home exists and holds it, and nothing else does', () => {
    if (rule.home !== null) {
      expect(PRODUCTION).toContain(rule.home);
      expect(rule.pattern.test(readFileSync(rule.home, 'utf8'))).toBe(true);
    }
    const copies = PRODUCTION.filter((file) => file !== rule.home && rule.pattern.test(readFileSync(file, 'utf8')));
    expect(copies).toEqual([]);
  });
});
