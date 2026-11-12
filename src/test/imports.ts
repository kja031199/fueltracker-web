import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

/**
 * What a source file imports, for the boundary tests (#93).
 *
 * Each of them used to match its own regular expression, and the layering one
 * saw only `from '…'` in single quotes: a double-quoted import, a dynamic
 * `import('…')`, or a bare `import '…'` crossed the boundary unseen. One
 * reader for all of them, tested on each form it has to catch.
 *
 * @trap #93 — A boundary test reads imports through `importsOf`, never its own
 * pattern. A new rule is a pure function of that list, tested on a planted
 * list, then run over the files.
 */

/** Comments out, so prose that mentions an import is not one. Strings are kept. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

/** Every module specifier a file names: static, re-exported, side-effect only, or dynamic. */
export function importsIn(source: string): string[] {
  const code = withoutComments(source);
  const patterns = [
    // import x from '…', import { a } from "…", export { b } from '…', across lines
    /\b(?:import|export)\b[^'"`;]*?\bfrom\s*(['"])([^'"]+)\1/g,
    // import '…' — for its side effects alone
    /\bimport\s*(['"])([^'"]+)\1/g,
    // import('…') — loaded later, but still a dependency
    /\bimport\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g,
  ];
  return patterns.flatMap((pattern) => [...code.matchAll(pattern)].map((match) => match[2]!));
}

/** Source files under `dir`, tests included unless `withTests` is false. */
export function sourcesUnder(dir: string, withTests = true): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name).replaceAll('\\', '/');
    if (statSync(path).isDirectory()) return sourcesUnder(path, withTests);
    if (!/\.tsx?$/.test(name)) return [];
    return withTests || !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** A relative specifier as a path from the repository root; a package name as itself. */
export function resolved(file: string, specifier: string): string {
  return specifier.startsWith('.') ? normalize(join(dirname(file), specifier)).replaceAll('\\', '/') : specifier;
}

/** What `file` imports, each resolved. */
export function importsOf(file: string): string[] {
  return importsIn(readFileSync(file, 'utf8')).map((specifier) => resolved(file, specifier));
}
