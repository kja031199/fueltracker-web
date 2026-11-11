/**
 * The browser half of the OCR check (#17): the app's **real** `recognise`,
 * built by the app's real Vite config, run on a receipt drawn here — and the
 * app's real **import pipeline** (`importReceiptPhoto`), which is what a scan
 * actually goes through. The first version called `recognise` directly with a
 * Blob, and so missed that the pipeline handed tesseract an `ImageBitmap`,
 * which it reads as zero bytes: every real scan failed while this passed.
 *
 * Built only when `OCR_PROBE=1` — see `scripts/ocr-check/check.mjs`. Nothing
 * here ships.
 */
import { recognise, releaseReader } from '../../src/ui/ocr';
import { importReceiptPhoto } from '../../src/ui/importReceipt';
import { prepareImage } from '../../src/ui/receiptImage';

/** A plain receipt, drawn rather than committed as a binary fixture. */
async function receipt(type = 'image/png'): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = 900;
  canvas.height = 420;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('no 2d context');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#000000';
  context.font = 'bold 44px monospace';
  ['SHELL 1234 MAIN ST', 'GALLONS 10.512', 'PRICE/GAL 3.919', 'TOTAL $41.23'].forEach((line, i) =>
    context.fillText(line, 40, 80 + i * 90),
  );
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob === null ? reject(new Error('no blob')) : resolve(blob)), type, 0.95),
  );
}

declare global {
  interface Window {
    runOcr: () => Promise<unknown>;
    runImport: () => Promise<unknown>;
    runImportFrom: (url: string) => Promise<unknown>;
    readFrom: (url: string) => Promise<unknown>;
    swReady: () => Promise<boolean>;
    releaseReader: () => Promise<void>;
  }
}

window.runOcr = async () => recognise(await receipt());

/**
 * Drops the reader the app keeps between scans (#90), so the next scan loads
 * one afresh — which is what the offline scenario has to prove it can do.
 */
window.releaseReader = releaseReader;

/** What a scan suggests, without the photo bytes, so it crosses `evaluate`. */
async function suggest(photo: Blob): Promise<unknown> {
  const outcome = await importReceiptPhoto(photo);
  if (!outcome.ok) return outcome;
  const { receiptImageData, date, ...rest } = outcome.suggestion;
  return { ok: true, ...rest, date: date?.toISOString() ?? null, photoBytes: receiptImageData?.byteLength ?? 0 };
}

/** The real pipeline, on the drawn receipt as a camera would hand it over: a JPEG file. */
window.runImport = async () => suggest(new File([await receipt('image/jpeg')], 'receipt.jpg', { type: 'image/jpeg' }));

/** The real pipeline, on a real photo the check serves (`--photo`, local only). */
window.runImportFrom = async (url: string) => {
  const blob = await (await fetch(url)).blob();
  return suggest(new File([blob], 'photo.jpg', { type: blob.type || 'image/jpeg' }));
};

/** Registers the app's service worker and resolves once it controls this page. */
window.swReady = async () => {
  await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`);
  await navigator.serviceWorker.ready;
  return navigator.serviceWorker.controller !== null;
};

/** Just the recognised lines of a served photo, for diagnosing the parser. */
window.readFrom = async (url: string) => {
  // Exactly what the import path reads: the prepared copy, not the raw file.
  const prepared = await prepareImage(await (await fetch(url)).blob());
  return prepared.ok ? recognise(prepared.image.forOcr) : prepared;
};
