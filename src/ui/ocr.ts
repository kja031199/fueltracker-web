/**
 * Reading text out of a receipt photo.
 *
 * ## Loaded on demand, and never precached
 *
 * Tesseract's core plus its English training data is well over ten megabytes.
 * Precaching that would make **every** install pay for a feature many people
 * will never open, on an app whose whole bundle is otherwise under a hundred
 * kilobytes. So it is imported lazily and fetched from the network, with one
 * honest consequence: **scanning is the only part of this app that needs a
 * connection.** Everything else works offline.
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

export type OcrFailure = 'unavailable' | 'no-text';

export type OcrResult =
  | { readonly ok: true; readonly lines: string[]; readonly confidence: number }
  | { readonly ok: false; readonly reason: OcrFailure };

export function describeOcrFailure(reason: OcrFailure): string {
  switch (reason) {
    case 'unavailable':
      return 'The text reader could not be loaded. It needs a connection the first time — everything else here works offline.';
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

export async function recognise(image: ImageBitmap | Blob): Promise<OcrResult> {
  let worker: OcrWorker;
  try {
    const { createWorker } = await import('tesseract.js');
    worker = (await createWorker('eng')) as unknown as OcrWorker;
  } catch {
    return { ok: false, reason: 'unavailable' };
  }

  try {
    const { data } = await worker.recognize(image);
    const lines = data.text
      .split('\n')
      .map((line: string) => line.trim())
      .filter((line: string) => line !== '');
    if (lines.length === 0) return { ok: false, reason: 'no-text' };
    return { ok: true, lines, confidence: data.confidence };
  } catch {
    return { ok: false, reason: 'unavailable' };
  } finally {
    await worker.terminate().catch(() => {});
  }
}
