import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { sourcesUnder } from './imports';

/**
 * Inline `style` only for a value worked out at render time (#93).
 *
 * There were 94 inline styles, most of them fixed spacing and the same grey
 * small text in four sizes, and an `opacity: 0.8` on text that no contrast
 * test could see. Fixed styling is a class in `styles.css` now; what stays
 * inline is computed — a metric's hue, a colour that depends on a total.
 */

/** Every `style={{ … }}` object body in `source`, read with balanced braces so multi-line ones count. */
export function inlineStyles(source: string): string[] {
  const found: string[] = [];
  let from = 0;
  for (;;) {
    const start = source.indexOf('style={{', from);
    if (start === -1) return found;
    let depth = 0;
    let i = start + 'style={'.length;
    for (; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    found.push(source.slice(start + 'style={{'.length, i).trim());
    from = i;
  }
}

/** The values in an object body, split at top-level commas. */
function values(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (const ch of body) {
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) depth -= 1;
    else if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => part.slice(part.indexOf(':') + 1).trim());
}

const LITERAL = /^(-?\d+(\.\d+)?|'[^']*'|"[^"]*"|`[^`$]*`)$/;

/** True when nothing in the style is worked out at render time. */
export function isStatic(body: string): boolean {
  return values(body).every((value) => LITERAL.test(value));
}

const COMPONENTS = sourcesUnder('src/ui', false).filter((file) => file.endsWith('.tsx'));

describe('inline styles are only for computed values', () => {
  test('the check catches a fixed style, one line or many, and passes a computed one', () => {
    const fixed = [
      "<p style={{ margin: 0 }}>",
      "<p style={{ margin: '0 0 8px', opacity: 0.8 }}>",
      "<ul\n  style={{\n    listStyle: 'none',\n    margin: 0,\n    padding: 0,\n  }}\n>",
      '<svg style={{ display: `block` }}>',
    ];
    for (const source of fixed) {
      expect(inlineStyles(source), source).toHaveLength(1);
      expect(isStatic(inlineStyles(source)[0]!), source).toBe(true);
    }
    const computed = [
      '<span style={{ color: `var(--accent-${hue})` }}>',
      "<strong style={{ color: total > 0 ? 'var(--text-primary)' : 'var(--text-secondary)' }}>",
      "<div style={{ fontSize: '1.5rem', color: colourFor(kpi) }}>",
      '<div style={{ width }}>',
    ];
    for (const source of computed) expect(isStatic(inlineStyles(source)[0]!), source).toBe(false);
  });

  test('there are components to check', () => {
    expect(COMPONENTS.length).toBeGreaterThanOrEqual(30);
  });

  test.each(COMPONENTS)('%s', (file) => {
    const fixed = inlineStyles(readFileSync(file, 'utf8')).filter(isStatic);
    expect(fixed).toEqual([]);
  });
});
