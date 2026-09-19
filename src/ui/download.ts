/**
 * Handing a file to the browser, and reading one back.
 *
 * Kept to its own module and as thin as it can be, because this is the only
 * part of export that needs a DOM — everything above it stays testable without
 * one. There is no logic here worth testing; there is logic everywhere else.
 */

/** Offers `text` to the reader as a download named `filename`. */
export function downloadText(text: string, filename: string, mimeType: string): void {
  const blob = new Blob([text], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  // Revoking immediately can cancel the download in some browsers, so the
  // object URL is released on the next tick instead of in this one.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
