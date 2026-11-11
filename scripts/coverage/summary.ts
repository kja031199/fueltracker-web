/**
 * The test coverage, as a table in the CI job summary (#99).
 *
 * Informational only: it reads `coverage/coverage-summary.json`, which
 * `npm run test:coverage` writes, and prints its four totals. It never fails —
 * a missing or unreadable summary is said, not thrown — because a coverage
 * number is something to look at, not a gate, and there is no threshold.
 *
 *   node --experimental-strip-types scripts/coverage/summary.ts >> "$GITHUB_STEP_SUMMARY"
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const KINDS = [
  ['lines', 'Lines'],
  ['statements', 'Statements'],
  ['functions', 'Functions'],
  ['branches', 'Branches'],
] as const;

/** A Markdown table of the totals in a json-summary report, or a line saying there is none. */
export function coverageTable(json: string | null): string {
  const none = '## Coverage\n\nNo coverage summary was written.\n';
  if (json === null) return none;
  let total: Record<string, { pct?: unknown } | undefined>;
  try {
    total = (JSON.parse(json) as { total?: typeof total }).total ?? {};
  } catch {
    return none;
  }
  const rows = KINDS.map(([key, label]) => {
    const pct = total[key]?.pct;
    return typeof pct === 'number' && Number.isFinite(pct) ? `| ${label} | ${pct.toFixed(1)}% |` : null;
  });
  if (rows.some((row) => row === null)) return none;
  return [
    '## Coverage',
    '',
    'Of `src/` and `scripts/`, tests excluded. Reported, not enforced.',
    '',
    '| | |',
    '|---|---|',
    ...rows,
    '',
  ].join('\n');
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let json: string | null = null;
  try {
    json = readFileSync('coverage/coverage-summary.json', 'utf8');
  } catch {
    json = null;
  }
  console.log(coverageTable(json));
}
