/**
 * Is each binary CI downloads by hand still the latest release? (#99)
 *
 * gitleaks and lychee are pinned by version and SHA-256 in `checks.yml`
 * (#46). Those are environment variables, which Dependabot cannot see, so
 * nothing would ever say a pin had fallen behind. This reads them, asks GitHub
 * for each tool's latest release, and exits non-zero if any is behind;
 * `.github/workflows/pins.yml` runs it weekly and on demand.
 *
 * It only reports. Bumping a pin means bumping its hash, from the release's
 * published checksums confirmed against a download of your own — never from
 * this check (docs/deploying.md).
 *
 *   node --experimental-strip-types scripts/pins/check.ts
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export interface Pin {
  readonly tool: string;
  /** `owner/name` on GitHub, where its releases are. */
  readonly repo: string;
  /** As pinned, `v` and all. */
  readonly version: string;
}

/** The binaries `checks.yml` downloads, and the variable each is pinned by. */
const TOOLS: readonly { readonly tool: string; readonly repo: string; readonly variable: string }[] = [
  { tool: 'gitleaks', repo: 'gitleaks/gitleaks', variable: 'GITLEAKS_VERSION' },
  { tool: 'lychee', repo: 'lycheeverse/lychee', variable: 'LYCHEE_VERSION' },
];

/** Every pin in `checks.yml`. A pin that has gone missing throws: a check that finds nothing must not pass. */
export function pinsIn(workflow: string): Pin[] {
  return TOOLS.map(({ tool, repo, variable }) => {
    const version = new RegExp(`^\\s*${variable}:\\s*(\\S+)\\s*$`, 'm').exec(workflow)?.[1];
    if (version === undefined) throw new Error(`checks.yml has no ${variable}`);
    return { tool, repo, version };
  });
}

/** The three numbers of `1.2.3`, `v1.2.3` or a tag like `lychee-v1.2.3`. Anything else is refused. */
function parts(version: string): [number, number, number] {
  const match = /^(?:[a-z-]*-)?v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (match === null) throw new Error(`${JSON.stringify(version)} is not a version`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Negative when `a` is older than `b`, zero when the same, positive when newer. */
export function compareVersions(a: string, b: string): number {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i += 1) {
    if (x[i] !== y[i]) return x[i]! - y[i]!;
  }
  return 0;
}

/** Whether a newer release than the pin exists. */
export function behind(pin: Pin, latest: string): boolean {
  return compareVersions(pin.version, latest) < 0;
}

async function latestRelease(repo: string): Promise<string> {
  const token = process.env['GITHUB_TOKEN'];
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: {
      Accept: 'application/vnd.github+json',
      ...(token === undefined || token === '' ? {} : { Authorization: `Bearer ${token}` }),
    },
  });
  if (!response.ok) throw new Error(`${repo}: GitHub answered ${response.status}`);
  const body = (await response.json()) as { tag_name?: unknown };
  if (typeof body.tag_name !== 'string') throw new Error(`${repo}: no tag on the latest release`);
  return body.tag_name;
}

async function main(): Promise<number> {
  const pins = pinsIn(readFileSync('.github/workflows/checks.yml', 'utf8'));
  const rows: string[] = [];
  let stale = 0;
  for (const pin of pins) {
    const latest = await latestRelease(pin.repo);
    const old = behind(pin, latest);
    if (old) stale += 1;
    rows.push(`| ${pin.tool} | ${pin.version} | ${latest} | ${old ? '**behind**' : 'current'} |`);
  }
  const summary = [
    '## Binary pins',
    '',
    '| Tool | Pinned | Latest | |',
    '|---|---|---|---|',
    ...rows,
    '',
    stale === 0
      ? 'Every pin is the latest release.'
      : 'Bump a pin together with its SHA-256, from the release’s checksums confirmed against your own download (docs/deploying.md).',
  ].join('\n');
  console.log(summary);
  const stepSummary = process.env['GITHUB_STEP_SUMMARY'];
  if (stepSummary !== undefined && stepSummary !== '') appendFileSync(stepSummary, `${summary}\n`);
  return stale === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
