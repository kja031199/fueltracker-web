/**
 * The capture date embedded in a photo.
 *
 * Worth reading because a receipt is usually photographed *after* the fill-up,
 * sometimes days later — so the printed date on the receipt beats the file's,
 * and the file's beats "now". This supplies the middle rung.
 *
 * GPS is deliberately **not** read, even though the metadata often carries it.
 * Location capture was dropped from this port by decision, and quietly
 * harvesting a coordinate from a photo would reintroduce it through the back
 * door — exactly the kind of thing the privacy posture is supposed to prevent.
 */

/** Rejects a date that cannot be a photo of a past fuel purchase. */
function plausible(date: Date, now: Date): boolean {
  if (Number.isNaN(date.getTime())) return false;
  // A day of clock skew, matching the receipt parser's own allowance.
  if (date.getTime() > now.getTime() + 86_400_000) return false;
  return date.getFullYear() >= 1990;
}

/**
 * The photo's capture date, or `null`.
 *
 * `exifr` is imported lazily: most fill-ups are typed by hand and never touch
 * this path, so its parser should not sit in the initial bundle.
 */
export async function photoCaptureDate(file: Blob, now: Date = new Date()): Promise<Date | null> {
  try {
    // The `mini` build rather than the default: this needs two date tags, and
    // the full parser is three times the size for formats a fuel receipt will
    // never be in.
    const { parse } = await import('exifr/dist/mini.esm.mjs');
    const tags: unknown = await parse(file, ['DateTimeOriginal', 'CreateDate']);
    if (typeof tags !== 'object' || tags === null) return null;
    const record = tags as Record<string, unknown>;
    for (const key of ['DateTimeOriginal', 'CreateDate']) {
      const value = record[key];
      if (value instanceof Date && plausible(value, now)) return value;
    }
    return null;
  } catch {
    // No EXIF, an unreadable header, or a browser that would not parse it.
    // A missing capture date is normal, not an error.
    return null;
  }
}
