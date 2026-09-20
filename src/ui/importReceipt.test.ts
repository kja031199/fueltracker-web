// @vitest-environment jsdom
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { importReceiptPhoto } from './importReceipt';
import type { OcrResult } from './ocr';

/**
 * jsdom has no image decoder or canvas encoder, so both are stubbed. The point
 * of these tests is the *decisions* — what gets suggested, what gets declined —
 * not the pixel plumbing, which the browser run covers.
 */
function stubImagePipeline(): void {
  vi.stubGlobal('createImageBitmap', async () =>
    ({ width: 1200, height: 1600, close: () => {} }) as unknown as ImageBitmap,
  );
  const proto = HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
  proto['getContext'] = () => ({ drawImage: () => {} });
  proto['toBlob'] = (cb: (b: Blob | null) => void) => cb(new Blob([new Uint8Array([1, 2, 3])]));
}

const photo = (): Blob => new Blob([new Uint8Array(2048)], { type: 'image/jpeg' });

const RECEIPT_LINES = [
  'SHELL',
  '07/19/2026 14:35:07',
  'GALLONS 10.234',
  'PRICE/GAL $3.499',
  'FUEL TOTAL $35.81',
];

const NOW = new Date(2026, 9, 15);

const ocr = (lines: string[]): (() => Promise<OcrResult>) =>
  async () => ({ ok: true, lines, confidence: 90 });

beforeEach(() => {
  vi.unstubAllGlobals();
  stubImagePipeline();
});

describe('a readable receipt', () => {
  test('suggests the numbers, the date and the station', async () => {
    const outcome = await importReceiptPhoto(photo(), {
      recognise: ocr(RECEIPT_LINES),
      now: () => NOW,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.suggestion.gallons).toBe(10.234);
    expect(outcome.suggestion.pricePerGallon).toBe(3.499);
    expect(outcome.suggestion.station).toBe('Shell');
    expect(outcome.suggestion.date?.getFullYear()).toBe(2026);
    expect(outcome.suggestion.note).toBeNull();
  });

  test('keeps the bounded re-encoded photo, never the original bytes', async () => {
    const outcome = await importReceiptPhoto(photo(), {
      recognise: ocr(RECEIPT_LINES),
      now: () => NOW,
    });
    if (!outcome.ok) return;
    // The stub re-encodes to three bytes; the input was two kilobytes.
    expect(outcome.suggestion.receiptImageData.byteLength).toBe(3);
  });
});

describe('a misread receipt', () => {
  test('declines numbers that do not corroborate, and says so', async () => {
    // The measured perspective-skew failure: 16.234 gallons instead of 10.234,
    // comfortably inside the plausible range and 60% wrong.
    const outcome = await importReceiptPhoto(photo(), {
      recognise: ocr(['SHELL', '07/19/2026', 'GALLONS 16.234', 'FUEL TOTAL $35.81']),
      now: () => NOW,
    });
    if (!outcome.ok) return;
    expect(outcome.suggestion.gallons).toBeNull();
    expect(outcome.suggestion.pricePerGallon).toBeNull();
    expect(outcome.suggestion.note).toMatch(/could not be read confidently/i);
  });

  test('still offers the date and station, which are text rather than arithmetic', async () => {
    const outcome = await importReceiptPhoto(photo(), {
      recognise: ocr(['SHELL', '07/19/2026', 'GALLONS 16.234', 'FUEL TOTAL $35.81']),
      now: () => NOW,
    });
    if (!outcome.ok) return;
    expect(outcome.suggestion.station).toBe('Shell');
    expect(outcome.suggestion.date).not.toBeNull();
  });
});

describe('when nothing can be read', () => {
  test('keeps the photo anyway and explains', async () => {
    // A receipt attached to a hand-typed fill-up is the original point of
    // keeping receipts at all.
    const outcome = await importReceiptPhoto(photo(), {
      recognise: async () => ({ ok: false, reason: 'no-text' }),
      now: () => NOW,
    });
    if (!outcome.ok) return;
    expect(outcome.suggestion.receiptImageData.byteLength).toBe(3);
    expect(outcome.suggestion.gallons).toBeNull();
    expect(outcome.suggestion.note).toMatch(/no readable text/i);
  });

  test('explains that the reader needs a connection the first time', async () => {
    const outcome = await importReceiptPhoto(photo(), {
      recognise: async () => ({ ok: false, reason: 'unavailable' }),
      now: () => NOW,
    });
    if (!outcome.ok) return;
    expect(outcome.suggestion.note).toMatch(/connection/i);
  });
});

describe('hostile files', () => {
  test('rejects an empty file', async () => {
    const outcome = await importReceiptPhoto(new Blob([]), { recognise: ocr([]), now: () => NOW });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toMatch(/empty/i);
  });

  test('rejects an oversized file before decoding it', async () => {
    // The byte gate is the only part of the bounded-decode guarantee the web
    // can actually keep, so it has to run first.
    let decoded = false;
    vi.stubGlobal('createImageBitmap', async () => {
      decoded = true;
      return {} as ImageBitmap;
    });
    const huge = { size: 40 * 1024 * 1024, type: 'image/jpeg' } as Blob;
    const outcome = await importReceiptPhoto(huge, { recognise: ocr([]), now: () => NOW });
    expect(outcome.ok).toBe(false);
    expect(decoded).toBe(false);
  });

  test('rejects a file that is not an image', async () => {
    vi.stubGlobal('createImageBitmap', async () => {
      throw new Error('not an image');
    });
    const outcome = await importReceiptPhoto(photo(), { recognise: ocr([]), now: () => NOW });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toMatch(/not an image/i);
  });

  test('plausible-looking OCR junk is rejected by the parser ranges', async () => {
    const outcome = await importReceiptPhoto(photo(), {
      recognise: ocr(['ODOMETER 42150.0', 'OCTANE 87.0', 'PUMP #0000']),
      now: () => NOW,
    });
    if (!outcome.ok) return;
    expect(outcome.suggestion.gallons).toBeNull();
    expect(outcome.suggestion.pricePerGallon).toBeNull();
  });
});
