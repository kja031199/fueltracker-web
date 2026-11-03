/**
 * The browser half of the OCR check (#17): the app's **real** `recognise`,
 * built by the app's real Vite config, run on a receipt drawn here.
 *
 * Built only when `OCR_PROBE=1` — see `scripts/ocr-check/check.mjs`. Nothing
 * here ships.
 */
import { recognise } from '../../src/ui/ocr';

/** A plain receipt, drawn rather than committed as a binary fixture. */
async function receipt(): Promise<Blob> {
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
    canvas.toBlob((blob) => (blob === null ? reject(new Error('no blob')) : resolve(blob)), 'image/png'),
  );
}

declare global {
  interface Window {
    runOcr: () => Promise<unknown>;
    swReady: () => Promise<boolean>;
  }
}

window.runOcr = async () => recognise(await receipt());

/** Registers the app's service worker and resolves once it controls this page. */
window.swReady = async () => {
  await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`);
  await navigator.serviceWorker.ready;
  return navigator.serviceWorker.controller !== null;
};
