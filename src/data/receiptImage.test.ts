import { describe, expect, test } from 'vitest';
import {
  MAX_IMPORT_BYTES,
  MAX_OCR_DIMENSION,
  MAX_STORED_DIMENSION,
  describeFailure,
  fitScale,
} from './receiptImage';
import { MAX_RECEIPT_BYTES } from '../domain/fuelEntryDraft';

describe('fitScale', () => {
  test('leaves an image that already fits alone', () => {
    expect(fitScale(800, 600, 1600)).toBe(1);
    expect(fitScale(1600, 1200, 1600)).toBe(1);
  });

  test('scales by the long edge, whichever it is', () => {
    expect(fitScale(3200, 2400, 1600)).toBe(0.5);
    expect(fitScale(2400, 3200, 1600)).toBe(0.5);
  });

  test('does not divide by zero on a degenerate image', () => {
    expect(fitScale(0, 0, 1600)).toBe(1);
  });
});

describe('the ceilings', () => {
  test('the input gate is larger than the storage ceiling, deliberately', () => {
    // Phone photos routinely arrive at 8-12 MB and are perfectly fine; gating
    // intake at the 4 MB storage limit would reject ordinary pictures before
    // they were ever downsized.
    expect(MAX_IMPORT_BYTES).toBeGreaterThan(MAX_RECEIPT_BYTES);
  });

  test('OCR gets more detail than storage keeps', () => {
    // Recognition wants pixels; the archive copy only has to be readable.
    expect(MAX_OCR_DIMENSION).toBeGreaterThan(MAX_STORED_DIMENSION);
  });
});

describe('describeFailure', () => {
  test('every reason has something a person can act on', () => {
    for (const reason of ['too-large', 'empty', 'not-an-image', 'no-canvas'] as const) {
      const message = describeFailure(reason);
      expect(message.length).toBeGreaterThan(10);
      expect(message).toMatch(/[.!]$/);
    }
  });
});
