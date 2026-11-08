import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { MAX_SYNCED_RECEIPT_BYTES } from './remoteStore';

/**
 * The receipt bound in `firestore.rules` is the client's (#92).
 *
 * The client drops a receipt larger than `MAX_SYNCED_RECEIPT_BYTES` before it
 * pushes, so the rules' bound should never be hit by the app. If the two
 * drifted — the client constant raised alone — every upload batch holding a
 * receipt between the two sizes would be refused, row and all. Here, beside
 * the constant, because it lives with the Firebase SDK.
 */
const RULES = readFileSync('firestore.rules', 'utf8');

describe('the rules and the client agree on the largest receipt (#92)', () => {
  const bound = /function maxReceiptBytes\(\)\s*\{\s*return\s+(\d+);\s*\}/.exec(RULES)?.[1];

  test('the rules name the bound in one function, as a plain number', () => {
    expect(bound).toBeDefined();
  });

  test('it is the client constant', () => {
    expect(Number(bound)).toBe(MAX_SYNCED_RECEIPT_BYTES);
  });

  test('the receipt rule uses it', () => {
    expect(RULES).toMatch(/field is bytes && field\.size\(\) <= maxReceiptBytes\(\)/);
  });
});
