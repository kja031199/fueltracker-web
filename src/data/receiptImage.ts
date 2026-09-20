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
 * real, is recorded in the README, and is the price of the platform.
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

export interface PreparedImage {
  /** Re-encoded, bounded JPEG bytes — the only thing that reaches storage. */
  readonly stored: Uint8Array;
  /** A larger bitmap for recognition. Never persisted. */
  readonly forOcr: ImageBitmap;
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

function canvasToBytes(canvas: HTMLCanvasElement, quality: number): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    canvas.toBlob(
      (blob) => {
        if (blob === null) {
          resolve(null);
          return;
        }
        void blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)));
      },
      'image/jpeg',
      quality,
    );
  });
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

  const ocrScale = fitScale(bitmap.width, bitmap.height, MAX_OCR_DIMENSION);
  const forOcr =
    ocrScale === 1
      ? bitmap
      : await createImageBitmap(bitmap, {
          resizeWidth: Math.max(1, Math.round(bitmap.width * ocrScale)),
          resizeHeight: Math.max(1, Math.round(bitmap.height * ocrScale)),
          resizeQuality: 'high',
        });

  return {
    ok: true,
    image: { stored, forOcr, width: bitmap.width, height: bitmap.height },
  };
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
