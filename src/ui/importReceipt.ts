/**
 * One photo in, form fields out.
 *
 * Ties together the pieces that are individually testable — bounded intake,
 * EXIF date, OCR, the ported receipt parser, and the corroboration rule — and
 * decides what, if anything, is worth suggesting.
 */

import { prepareImage, describeFailure } from '../data/receiptImage';
import { photoCaptureDate } from '../data/photoMetadata';
import { parseReceipt } from '../domain/scanning/receiptScanParser';
import { isCorroborated, numbersIn } from '../domain/scanning/corroboration';
import { describeOcrFailure, recognise } from './ocr';
import type { OcrResult } from './ocr';

export interface ReceiptSuggestion {
  readonly gallons: number | null;
  readonly pricePerGallon: number | null;
  readonly date: Date | null;
  readonly station: string | null;
  /** The bounded, re-encoded photo — the only bytes that may be stored. */
  readonly receiptImageData: Uint8Array;
  /** What was read but not trusted, so the reader is told rather than left guessing. */
  readonly note: string | null;
}

export type ImportOutcome =
  | { readonly ok: true; readonly suggestion: ReceiptSuggestion }
  | { readonly ok: false; readonly message: string };

/** Injected so tests can drive this without loading Tesseract. */
export interface ImportDeps {
  readonly recognise: (image: ImageBitmap | Blob) => Promise<OcrResult>;
  readonly now: () => Date;
}

const defaultDeps: ImportDeps = { recognise, now: () => new Date() };

export async function importReceiptPhoto(
  file: Blob,
  deps: Partial<ImportDeps> = {},
): Promise<ImportOutcome> {
  const { recognise: read, now } = { ...defaultDeps, ...deps };

  const prepared = await prepareImage(file);
  if (!prepared.ok) return { ok: false, message: describeFailure(prepared.reason) };

  const capturedAt = await photoCaptureDate(file, now());
  const ocr = await read(prepared.image.forOcr);

  if (!ocr.ok) {
    // The photo is still worth keeping even when nothing could be read from
    // it — a receipt attached to a hand-typed fill-up is the original point of
    // the receipt vault.
    return {
      ok: true,
      suggestion: {
        gallons: null,
        pricePerGallon: null,
        date: capturedAt,
        station: null,
        receiptImageData: prepared.image.stored,
        note: describeOcrFailure(ocr.reason),
      },
    };
  }

  const receipt = parseReceipt(ocr.lines, now());
  const trusted = isCorroborated(receipt.reading, numbersIn(ocr.lines));

  return {
    ok: true,
    suggestion: {
      // Numbers are offered **only** when the three corroborate each other. A
      // misread digit almost always breaks the arithmetic, and a plausible
      // wrong number is worse than no number: 16 gallons instead of 10 would
      // quietly wreck a segment's economy, while a blank field is obvious.
      gallons: trusted ? receipt.reading.gallons : null,
      pricePerGallon: trusted ? receipt.reading.pricePerGallon : null,
      // The date and station are text, not arithmetic, so they do not ride on
      // the fuel numbers reconciling. A printed date beats the photo's own.
      date: receipt.purchaseDate ?? capturedAt,
      station: receipt.stationName,
      receiptImageData: prepared.image.stored,
      note: trusted
        ? null
        : 'The gallons and price could not be read confidently, so they were left for you to type. Everything else came through.',
    },
  };
}
