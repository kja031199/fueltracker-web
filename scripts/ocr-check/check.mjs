// The OCR browser check (#17). Run from the repository root:
//
//   node scripts/ocr-check/check.mjs
//
// It builds the app with the probe page added (OCR_PROBE=1) into a throwaway
// directory, serves it with the headers from firebase.json — the real CSP —
// and drives Chromium through four scenarios:
//
//   1. production CSP: a drawn receipt is read correctly;
//   2. every request the scan makes is to this origin (anything else is
//      blocked, so a CDN fallback would fail the scan, not just be counted);
//   3. after one scan with the service worker installed, scanning works with
//      the browser offline;
//   4. negative control: the same CSP minus 'wasm-unsafe-eval' must FAIL, cleanly —
//      which proves the check can fail, and is the failure the live site had
//      once #39 enforced the policy.
//
// Why this exists rather than the CSP watcher: a violation inside a worker is
// reported to the worker, not the page, so `__fuelTrackerCsp` never sees it.
//
// Pass `--photo <path>` to also run a real receipt photo through the app's
// import pipeline. It is served only to the check and never copied anywhere;
// keep real receipts (card digits, account numbers) out of the repository.
//
// Needs Playwright and Chromium. Not a dependency of this repository; in a
// fresh clone: `npm i --no-save playwright && npx playwright install chromium`.

import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  try {
    return require('playwright');
  } catch {
    const global = execSync('npm root -g').toString().trim();
    return require(join(global, 'playwright'));
  }
}
const { chromium } = loadPlaywright();

const EXPECTED = ['GALLONS 10.512', 'TOTAL $41.23'];
const photoArg = process.argv.indexOf('--photo');
const PHOTO = photoArg === -1 ? null : process.argv[photoArg + 1];
if (PHOTO !== null && (PHOTO === undefined || !existsSync(PHOTO))) throw new Error(`no such photo: ${PHOTO}`);

// --- Build -----------------------------------------------------------------
const out = mkdtempSync(join(tmpdir(), 'ocr-check-'));
console.log(`building the probe into ${out}`);
execFileSync('npx', ['vite', 'build', '--outDir', out, '--emptyOutDir'], {
  env: { ...process.env, OCR_PROBE: '1' },
  stdio: 'ignore',
});

// --- Serve with the production headers --------------------------------------
const hosting = JSON.parse(readFileSync('firebase.json', 'utf8')).hosting;
const everywhere = new Map(
  hosting.headers.find((entry) => entry.source === '**').headers.map((h) => [h.key, h.value]),
);
const PRODUCTION_CSP = everywhere.get('Content-Security-Policy');
if (!PRODUCTION_CSP) throw new Error('firebase.json has no Content-Security-Policy on **');

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.gz': 'application/gzip',
};

function serve(csp) {
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url, 'http://x').pathname);
    if (path === '/__local-photo' && PHOTO !== null) {
      response.setHeader('Content-Type', 'image/jpeg');
      return response.end(readFileSync(PHOTO));
    }
    let file = normalize(join(out, path));
    if (!file.startsWith(out) || !existsSync(file) || statSync(file).isDirectory()) {
      file = join(out, 'index.html'); // firebase.json rewrites ** to /index.html
    }
    for (const [key, value] of everywhere) response.setHeader(key, value);
    response.setHeader('Content-Security-Policy', csp);
    // No HTTP caching at all, so "offline" can only be answered by the
    // service worker's cache — the thing under test — and never by the
    // browser's own cache.
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream');
    response.end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// --- Drive Chromium --------------------------------------------------------
async function scenario(name, csp, run) {
  const server = await serve(csp);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const offOrigin = [];
  const console_ = [];
  const failures = [];
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(origin)) return route.continue();
    offOrigin.push(url);
    return route.abort(); // a CDN fallback fails the scan instead of hiding in a count
  });
  const page = await context.newPage();
  page.on('console', (message) => console_.push(message.text()));
  context.on('requestfailed', (request) => failures.push(`${request.url()} (${request.failure()?.errorText})`));
  page.on('worker', (worker) => worker.on('console', (message) => console_.push(`[worker] ${message.text()}`)));
  try {
    await page.goto(`${origin}/scripts/ocr-check/probe.html`);
    return await run({ page, context, offOrigin, console: console_, failures });
  } finally {
    await browser.close();
    server.close();
  }
}

const scan = (page) => page.evaluate(() => window.runOcr());
const readsReceipt = (result) =>
  result?.ok === true && EXPECTED.every((token) => result.lines.some((line) => line.includes(token)));

const results = [];
function report(name, passed, detail) {
  results.push(passed);
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
}

await scenario('production', PRODUCTION_CSP, async ({ page, offOrigin, console: logs }) => {
  const result = await scan(page);
  report('1. reads the receipt under the production CSP', readsReceipt(result), JSON.stringify(result));
  report('2. makes no request outside this origin', offOrigin.length === 0, offOrigin.join(', '));
  const violations = logs.filter((line) => /Content.Security.Policy|Refused/i.test(line));
  if (violations.length > 0) console.log(`      console: ${violations.join(' | ')}`);
});

await scenario('import', PRODUCTION_CSP, async ({ page, console: logs }) => {
  // The path a real scan takes: a JPEG file through prepareImage → recognise →
  // parseReceipt. Scenario 1 alone passed while every real scan failed.
  const result = await page.evaluate(() => window.runImport());
  report(
    "5. the app's real import pipeline fills in gallons and price",
    result?.ok === true && result.gallons === 10.512 && result.pricePerGallon === 3.919 && result.note === null,
    JSON.stringify(result) + (result?.note ? `; console: ${logs.slice(-2).join(' | ')}` : ''),
  );
  if (PHOTO !== null) {
    const real = await page.evaluate(() => window.runImportFrom('/__local-photo'));
    if (process.env.OCR_DEBUG) {
      const read = await page.evaluate(() => window.readFrom('/__local-photo'));
      console.log('      recognised lines:\n' + (read?.lines ?? []).map((line) => `        ${JSON.stringify(line)}`).join('\n'));
    }
    // Passes when the photo is *read* and values are offered. Whether they are
    // the right values is for a person holding the receipt to judge: this
    // script cannot know them, and a check that claimed to would be lying.
    // OCR_DEBUG=1 prints the recognised lines, for diagnosing the parser.
    report(
      '6. a real receipt photo (local only) is read and values offered — check them by eye',
      real?.ok === true && real.gallons !== null && real.pricePerGallon !== null,
      JSON.stringify(real),
    );
  }
});

await scenario('offline', PRODUCTION_CSP, async ({ page, context, failures, console: logs }) => {
  await page.evaluate(() => window.swReady());
  await page.reload(); // now controlled by the service worker
  const controlled = await page.evaluate(() => navigator.serviceWorker.controller !== null);
  const online = await scan(page); // first scan: fetched, and cached on the way
  if (process.env.OCR_DEBUG) {
    const cached = await page.evaluate(async () =>
      Promise.all((await caches.keys()).map(async (name) => [name, (await (await caches.open(name)).keys()).map((r) => r.url)])),
    );
    console.log('      caches after the online scan:', JSON.stringify(cached).replace(/http:[^"]*?(?=\/(tesseract|assets|index))/g, ''));
  }
  await context.setOffline(true);
  const offline = await scan(page);
  report(
    '3. after one scan, scans again offline',
    controlled && readsReceipt(online) && readsReceipt(offline),
    `controlled=${controlled} online=${readsReceipt(online)} offline=${JSON.stringify(offline)}` +
      (failures.length > 0 ? `; failed requests: ${failures.join(', ')}` : '') +
      (readsReceipt(offline) ? '' : `; console: ${logs.slice(-4).join(' | ')}`),
  );
});

const withoutWasm = PRODUCTION_CSP.replace(" 'wasm-unsafe-eval'", '');
if (withoutWasm === PRODUCTION_CSP) throw new Error("the CSP has no 'wasm-unsafe-eval' to remove");
await scenario('control', withoutWasm, async ({ page, console: logs }) => {
  // It must fail *cleanly*: the scan returns 'unavailable' once the reader's
  // load bound passes (READER_LOAD_TIMEOUT_MS, 90 s), rather than hanging —
  // which it did, until this scenario found it. The race below is only a
  // backstop so a regression fails the check instead of hanging it.
  const result = await Promise.race([
    scan(page),
    new Promise((resolve) => setTimeout(() => resolve({ ok: false, reason: 'hung' }), 150_000)),
  ]);
  report(
    "4. control: without 'wasm-unsafe-eval' the scan fails, and says so",
    result?.ok === false && result.reason === 'unavailable',
    `${JSON.stringify(result)}; console: ${logs.filter((l) => /wasm|Content.Security|Refused|CompileError/i.test(l)).slice(0, 1).join(' | ')}`,
  );
});

rmSync(out, { recursive: true, force: true });
const failed = results.filter((passed) => !passed).length;
console.log(failed === 0 ? '\nOCR check passed.' : `\nOCR check FAILED: ${failed} scenario(s).`);
process.exit(failed === 0 ? 0 : 1);
