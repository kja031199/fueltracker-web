/**
 * Reading text out of a receipt photo.
 *
 * ## Served from this origin, fetched on first scan
 *
 * Tesseract's worker, wasm core and English data come from **this site**, under
 * `tesseract/<version>/` — copied out of `node_modules` at build time by
 * `vite.config.ts` (#17). They used to come from jsDelivr at scan time, by
 * default: code nobody here built or pinned, running with this origin's access
 * to the fuel log, which neither the CSP nor SRI could tell from a substitute.
 *
 * About seven megabytes, so they are **not** precached — every install would
 * pay for a screen many people never open. The service worker caches them on
 * first use instead, so scanning needs a connection once and then works
 * offline like everything else.
 *
 * It also needs `'wasm-unsafe-eval'` in the CSP's `script-src`: the core is
 * WebAssembly, and without that token it fails to compile *inside the worker*,
 * where the page's violation watcher cannot see it. `docs/development.md` has
 * the browser check that catches that.
 *
 * ## What it is pointed at, and what it is not
 *
 * Receipts only. Measured against a pristine seven-segment pump display —
 * no photographic degradation at all — Tesseract returned confidence 36 and
 * nothing a parser could use (`"GAL =, ( (CZ"`). Seven-segment digits are
 * strokes with gaps, not glyphs, and a general text recogniser has no model for
 * them. Pump scanning is therefore not offered rather than offered badly; the
 * pump parser stays, because it costs nothing and reads receipt fuel lines.
 */

/**
 * Why a scan read nothing — kept apart because they send the reader to
 * different places. Until after #63 a failure *while reading the photo* was
 * reported as `'unavailable'`, so a phone that had loaded the reader fine was
 * told to check its connection, and the real cause (the photo arriving as zero
 * bytes) was invisible.
 *
 * - `unavailable` — the reader did not load (network, CSP, timeout);
 * - `unreadable` — it loaded, and failed on this photo;
 * - `no-text` — it read the photo and found nothing.
 */
export type OcrFailure = 'unavailable' | 'unreadable' | 'no-text';

export type OcrResult =
  | { readonly ok: true; readonly lines: string[]; readonly confidence: number }
  | {
      readonly ok: false;
      readonly reason: OcrFailure;
      /** The underlying error, shortened, so a screenshot says what failed. */
      readonly detail?: string;
    };

/** Longest detail shown: enough to name an error, short enough for a phone. */
const MAX_DETAIL = 200;

function detailOf(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL - 1)}…` : text;
}

export function describeOcrFailure(reason: OcrFailure, detail?: string): string {
  const suffix = detail === undefined || detail === '' ? '' : ` (Details: ${detail})`;
  switch (reason) {
    case 'unavailable':
      return `The text reader could not be loaded. It is downloaded from this site the first time you scan, so that first scan needs a connection.${suffix}`;
    case 'unreadable':
      return `The text reader could not read that photo. Try another shot, or just type the numbers in.${suffix}`;
    case 'no-text':
      return 'No readable text in that photo. Try a flatter, better-lit shot, or just type the numbers in.';
  }
}

/**
 * Recognises text in an image.
 *
 * The worker is created and terminated per call. Keeping one alive would save a
 * second on a repeat scan and hold tens of megabytes resident for a screen
 * nobody may open again — the wrong trade on a phone.
 */
interface OcrWorker {
  recognize(image: unknown): Promise<{ data: { text: string; confidence: number } }>;
  terminate(): Promise<unknown>;
}

/** Tesseract's `OEM.LSTM_ONLY`: the engine whose core variants are self-hosted. */
const LSTM_ONLY = 1;

/**
 * Every path the reader loads from, absolute and on this origin.
 *
 * **All three, always.** A path left out is not an error: tesseract.js quietly
 * falls back to its jsDelivr default — which is exactly how the CDN got in.
 * Absolute, because the worker resolves `corePath` and `langPath` against its
 * own URL, not the page's.
 *
 * `workerBlobURL: false` runs the worker from its real URL rather than
 * downloading it and wrapping it in a blob, so the CSP can allow workers from
 * `'self'` only — no `blob:` code with no URL anybody can audit.
 */
function readerPaths(): {
  workerPath: string;
  corePath: string;
  langPath: string;
  workerBlobURL: boolean;
} {
  const root = new URL(`${import.meta.env.BASE_URL}${__TESSERACT_ASSETS__}`, window.location.origin);
  return {
    workerPath: new URL('worker.min.js', root).href,
    corePath: new URL('core/', root).href,
    langPath: new URL('lang', root).href,
    workerBlobURL: false,
  };
}

/**
 * How long loading the reader may take before the scan gives up.
 *
 * Without a bound, a reader that cannot load never answers at all: when the
 * wasm core is refused — a CSP without `'wasm-unsafe-eval'`, which is what the
 * live site had — tesseract aborts inside its worker and `createWorker` never
 * settles, so the scan spun for ever with no message. The browser check's
 * negative control found it. Generous, because the first scan downloads about
 * seven megabytes, and a bound tuned to a fast desk would fail it on a phone.
 */
export const READER_LOAD_TIMEOUT_MS = 90_000;

/** Loads the reader, or rejects once the bound above has passed. */
async function loadReader(): Promise<OcrWorker> {
  const { createWorker } = await import('tesseract.js');
  const loading = createWorker('eng', LSTM_ONLY, readerPaths()) as unknown as Promise<OcrWorker>;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('the reader did not load in time')), READER_LOAD_TIMEOUT_MS);
  });
  try {
    return await Promise.race([loading, timeout]);
  } catch (cause) {
    // A worker that turns up after we gave up must not be left running.
    void loading.then((late) => late.terminate()).catch(() => {});
    throw cause;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads the text in an encoded image. **A `Blob` only**: tesseract.js turns an
 * `ImageBitmap` into zero bytes, which is how every real scan failed until
 * after #63.
 */
export async function recognise(image: Blob): Promise<OcrResult> {
  let worker: OcrWorker;
  try {
    worker = await loadReader();
  } catch (cause) {
    return { ok: false, reason: 'unavailable', detail: detailOf(cause) };
  }

  try {
    const { data } = await worker.recognize(image);
    const lines = data.text
      .split('\n')
      .map((line: string) => line.trim())
      .filter((line: string) => line !== '');
    if (lines.length === 0) return { ok: false, reason: 'no-text' };
    return { ok: true, lines, confidence: data.confidence };
  } catch (cause) {
    return { ok: false, reason: 'unreadable', detail: detailOf(cause) };
  } finally {
    await worker.terminate().catch(() => {});
  }
}
