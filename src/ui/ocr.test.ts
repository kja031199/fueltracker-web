// @vitest-environment jsdom
import { beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * Where the receipt reader comes from (#17).
 *
 * `createWorker('eng')` with no paths made tesseract.js fetch its worker, its
 * wasm core and the English data from jsDelivr at scan time — code nobody
 * here built or pinned, running with this origin's access to IndexedDB. Every
 * path is now ours, and this pins what is handed to the library, since a path
 * left out silently falls back to the CDN default.
 */
const createWorker = vi.fn();
vi.mock('tesseract.js', () => ({ createWorker }));

const { READER_LOAD_TIMEOUT_MS, describeOcrFailure, recognise } = await import('./ocr');

function workerReturning(text: string, confidence = 90) {
  return {
    recognize: vi.fn(async () => ({ data: { text, confidence } })),
    terminate: vi.fn(async () => undefined),
  };
}

beforeEach(() => {
  createWorker.mockReset();
});

describe('the reader is loaded from this origin', () => {
  test('worker, core and language data are all same-origin, under a versioned path', async () => {
    createWorker.mockResolvedValue(workerReturning('TOTAL 41.23'));
    await recognise(new Blob(['x']));

    const [lang, oem, options] = createWorker.mock.calls[0]!;
    expect(lang).toBe('eng');
    expect(oem).toBe(1); // LSTM only: the core variants that are self-hosted
    for (const key of ['workerPath', 'corePath', 'langPath'] as const) {
      const url = new URL(options[key] as string);
      expect(url.origin, key).toBe(window.location.origin);
      expect(url.pathname, key).toMatch(/^\/tesseract\/\d+\.\d+\.\d+\//);
    }
  });

  test('the worker is a real script URL, not a blob wrapped around a download', async () => {
    // A blob worker needs `worker-src blob:`, and is code with no URL to audit.
    createWorker.mockResolvedValue(workerReturning('TOTAL 41.23'));
    await recognise(new Blob(['x']));
    expect(createWorker.mock.calls[0]![2]).toMatchObject({ workerBlobURL: false });
  });

  test('names no other host anywhere in what it passes', async () => {
    createWorker.mockResolvedValue(workerReturning('TOTAL 41.23'));
    await recognise(new Blob(['x']));
    const passed = JSON.stringify(createWorker.mock.calls[0]);
    expect(passed).not.toMatch(/jsdelivr|unpkg|cdn\./i);
  });
});

describe('what it reports, unchanged', () => {
  test('returns the non-empty lines and the confidence', async () => {
    createWorker.mockResolvedValue(workerReturning('  TOTAL 41.23 \n\n GALLONS 10.512 ', 87));
    expect(await recognise(new Blob(['x']))).toEqual({
      ok: true,
      lines: ['TOTAL 41.23', 'GALLONS 10.512'],
      confidence: 87,
    });
  });

  test('a reader that cannot load is unavailable, not a crash', async () => {
    createWorker.mockRejectedValue(new Error('NetworkError'));
    expect(await recognise(new Blob(['x']))).toMatchObject({ ok: false, reason: 'unavailable' });
  });

  test('a photo with no text says so', async () => {
    createWorker.mockResolvedValue(workerReturning('   \n  '));
    expect(await recognise(new Blob(['x']))).toEqual({ ok: false, reason: 'no-text' });
  });

  test('the worker is always shut down, even when reading fails', async () => {
    const worker = workerReturning('');
    worker.recognize.mockRejectedValue(new Error('boom'));
    createWorker.mockResolvedValue(worker);
    await recognise(new Blob(['x']));
    expect(worker.terminate).toHaveBeenCalled();
  });
});

describe('a reader that never finishes loading (#17)', () => {
  /**
   * Found by the browser check's negative control: when the wasm core is
   * refused — a CSP without `'wasm-unsafe-eval'`, as the live site had —
   * tesseract aborts inside its worker and `createWorker` never settles. The
   * scan then waited for ever, with a spinner and no message.
   */
  test('gives up after a bounded wait and says the reader is unavailable', async () => {
    vi.useFakeTimers();
    try {
      createWorker.mockReturnValue(new Promise(() => {}));
      const pending = recognise(new Blob(['x']));

      await vi.advanceTimersByTimeAsync(READER_LOAD_TIMEOUT_MS);

      expect(await pending).toMatchObject({ ok: false, reason: 'unavailable' });
    } finally {
      vi.useRealTimers();
    }
  });

  test('does not give up early on a slow first download', async () => {
    // Seven megabytes on a poor connection takes a while; a timeout tuned to
    // a fast desk would fail the very first scan on a phone.
    expect(READER_LOAD_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
    vi.useFakeTimers();
    try {
      let finish: (worker: unknown) => void = () => {};
      createWorker.mockReturnValue(new Promise((resolve) => (finish = resolve)));
      const pending = recognise(new Blob(['x']));

      await vi.advanceTimersByTimeAsync(READER_LOAD_TIMEOUT_MS - 1);
      finish(workerReturning('TOTAL 41.23'));

      expect(await pending).toMatchObject({ ok: true, lines: ['TOTAL 41.23'] });
    } finally {
      vi.useRealTimers();
    }
  });

  test('a worker that turns up after it gave up is shut down, not left running', async () => {
    vi.useFakeTimers();
    try {
      let finish: (worker: unknown) => void = () => {};
      createWorker.mockReturnValue(new Promise((resolve) => (finish = resolve)));
      const pending = recognise(new Blob(['x']));
      await vi.advanceTimersByTimeAsync(READER_LOAD_TIMEOUT_MS);
      expect(await pending).toMatchObject({ ok: false, reason: 'unavailable' });

      const late = workerReturning('TOTAL 41.23');
      finish(late);
      await vi.advanceTimersByTimeAsync(0);

      expect(late.terminate).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a failure says which part failed (after #63)', () => {
  /**
   * After #63 the reader loaded, and the first real scan on a phone still said
   * "The text reader could not be loaded… needs a connection" — while online.
   * Every throw was reported as `'unavailable'`, including a throw while
   * *reading the photo*, which is what had happened: the app handed tesseract
   * an `ImageBitmap`, which it silently turns into zero bytes. The message sent
   * the reader to check their connection, and the screenshot said nothing
   * about the real cause.
   */
  test('a reader that loads but fails on the photo is unreadable, not unavailable', async () => {
    const worker = workerReturning('');
    worker.recognize.mockRejectedValue(new Error('Error attempting to read image.'));
    createWorker.mockResolvedValue(worker);

    expect(await recognise(new Blob(['x']))).toEqual({
      ok: false,
      reason: 'unreadable',
      detail: 'Error attempting to read image.',
    });
  });

  test('a reader that cannot load carries why', async () => {
    createWorker.mockRejectedValue(new Error('NetworkError when attempting to fetch resource.'));
    expect(await recognise(new Blob(['x']))).toEqual({
      ok: false,
      reason: 'unavailable',
      detail: 'NetworkError when attempting to fetch resource.',
    });
  });

  test('a throw that is not an Error still produces a detail, never "undefined"', async () => {
    createWorker.mockRejectedValue('aborted');
    const result = await recognise(new Blob(['x']));
    expect(result).toMatchObject({ ok: false, reason: 'unavailable', detail: 'aborted' });
  });

  test('a very long detail is cut short', async () => {
    createWorker.mockRejectedValue(new Error('x'.repeat(5000)));
    const result = await recognise(new Blob(['x']));
    if (result.ok) throw new Error('expected a failure');
    expect(result.detail?.length).toBeLessThanOrEqual(200);
  });

  test('the photo reaches the reader as the Blob it was given', async () => {
    const worker = workerReturning('TOTAL 41.23');
    createWorker.mockResolvedValue(worker);
    const photo = new Blob(['jpeg bytes'], { type: 'image/jpeg' });

    await recognise(photo);

    expect(worker.recognize).toHaveBeenCalledWith(photo);
  });
});

describe('what each failure tells the reader', () => {
  test('only a reader that did not load mentions the connection', () => {
    expect(describeOcrFailure('unavailable')).toMatch(/connection/i);
    expect(describeOcrFailure('unreadable')).not.toMatch(/connection/i);
    expect(describeOcrFailure('no-text')).not.toMatch(/connection/i);
  });

  test('the detail is shown when there is one, so a screenshot says what failed', () => {
    expect(describeOcrFailure('unreadable', 'Error attempting to read image.')).toContain(
      'Error attempting to read image.',
    );
    expect(describeOcrFailure('unreadable')).not.toMatch(/details/i);
  });
});

