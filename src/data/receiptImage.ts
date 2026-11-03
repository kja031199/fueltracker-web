/**
 * Preparing a chosen photo for storage, the analogue of
 * `FuelTracker/Scanning/ReceiptImage.swift`.
 *
 * ## The invariant, and the part of it the web cannot keep
 *
 * Upstream this is invariant 5: untrusted images go through a **bounded
 * decode**, never a raw full-resolution one, because a small crafted file can
 * declare enormous pixel dimensions and exhaust memory when decompressed — a
 * decompression bomb. iOS has a primitive for exactly this: ImageIO's thumbnail
 * generator decodes straight to a bounded size and never materialises the full
 * bitmap.
 *
 * **The web has no equivalent.** `createImageBitmap` accepts resize options but
 * is not specified to avoid decoding at full size first, and neither is an
 * `<img>`. So the guarantee degrades to a defence in depth:
 *
 * 1. a **byte ceiling checked before anything is decoded**, which stops the
 *    cheap version of the attack — a few-kilobyte file claiming 50,000 pixels
 *    a side never reaches a decoder;
 * 2. a bounded re-encode after, so whatever is *stored* is small regardless.
 *
 * The residual gap — a large-but-legitimate-looking file that decodes huge — is
 * real, is recorded in docs/port.md, and is the price of the platform.
 */

/**
 * Largest file accepted for decoding.
 *
 * Deliberately a different number from `MAX_RECEIPT_BYTES` (4 MB), which bounds
 * what gets *stored*: phone photos routinely arrive at 8-12 MB and are fine, so
 * gating the input at the storage ceiling would reject ordinary pictures.
 */
export const MAX_IMPORT_BYTES = 24 * 1024 * 1024;

/** Longest edge of the stored copy. Enough to read a receipt, small to keep. */
export const MAX_STORED_DIMENSION = 1600;

/** Longest edge handed to OCR. Larger, because recognition wants detail. */
export const MAX_OCR_DIMENSION = 2400;

export const STORED_QUALITY = 0.7;

/** JPEG quality of the copy handed to OCR: high, because recognition wants edges. */
export const OCR_QUALITY = 0.92;

export interface PreparedImage {
  /** Re-encoded, bounded JPEG bytes — the only thing that reaches storage. */
  readonly stored: Uint8Array;
  /**
   * A larger copy for recognition, **as an encoded image `Blob`**. Never
   * persisted.
   *
   * Not an `ImageBitmap`, which it used to be. tesseract.js reads a Blob, File
   * or canvas, and anything else falls through its loader to
   * `new Uint8Array(image)` — zero bytes for a bitmap — so every real scan
   * failed with "pix not read", reported as the reader not loading. Typed
   * `Blob` so a bitmap cannot be handed over again.
   */
  readonly forOcr: Blob;
  readonly width: number;
  readonly height: number;
}

export type PrepareFailure =
  | 'too-large'
  | 'empty'
  | 'not-an-image'
  | 'no-canvas';

export type PrepareResult =
  | { readonly ok: true; readonly image: PreparedImage }
  | { readonly ok: false; readonly reason: PrepareFailure };

/** The scale factor that fits `width`×`height` inside `max` on its long edge. */
export function fitScale(width: number, height: number, max: number): number {
  const longest = Math.max(width, height);
  if (longest <= 0) return 1;
  return longest <= max ? 1 : max / longest;
}

async function draw(bitmap: ImageBitmap, max: number): Promise<HTMLCanvasElement | null> {
  const scale = fitScale(bitmap.width, bitmap.height, max);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext('2d');
  if (context === null) return null;
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

async function canvasToBytes(canvas: HTMLCanvasElement, quality: number): Promise<Uint8Array | null> {
  const blob = await canvasToBlob(canvas, quality);
  return blob === null ? null : new Uint8Array(await blob.arrayBuffer());
}

/**
 * Decodes a chosen file to a bounded size and re-encodes what will be stored.
 *
 * Returns a reason rather than throwing, because every failure here is
 * something to tell the reader rather than a bug: they picked a PDF, or a photo
 * too large to work with.
 */
export async function prepareImage(file: Blob): Promise<PrepareResult> {
  if (file.size === 0) return { ok: false, reason: 'empty' };
  // Checked first, before a decoder ever sees the bytes.
  if (file.size > MAX_IMPORT_BYTES) return { ok: false, reason: 'too-large' };

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { ok: false, reason: 'not-an-image' };
  }

  const storedCanvas = await draw(bitmap, MAX_STORED_DIMENSION);
  if (storedCanvas === null) return { ok: false, reason: 'no-canvas' };
  const stored = await canvasToBytes(storedCanvas, STORED_QUALITY);
  if (stored === null) return { ok: false, reason: 'no-canvas' };

  // Drawn and encoded the same way as the stored copy, only larger and at a
  // higher quality, so what tesseract receives is an image file it can read.
  const ocrCanvas = await draw(bitmap, MAX_OCR_DIMENSION);
  const forOcr = ocrCanvas === null ? null : await canvasToBlob(ocrCanvas, OCR_QUALITY);
  const { width, height } = bitmap;
  bitmap.close();
  if (forOcr === null) return { ok: false, reason: 'no-canvas' };

  return { ok: true, image: { stored, forOcr, width, height } };
}

export function describeFailure(reason: PrepareFailure): string {
  switch (reason) {
    case 'too-large':
      return 'That photo is too large to read. Try a smaller one.';
    case 'empty':
      return 'That file is empty.';
    case 'not-an-image':
      return 'That file is not an image.';
    case 'no-canvas':
      return 'This browser would not let the image be processed.';
  }
}
