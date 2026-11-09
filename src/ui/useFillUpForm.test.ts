// @vitest-environment jsdom
import { describe, expect, test, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { US } from '../domain/units';
import type { ImportOutcome } from './importReceipt';
import { useFillUpForm } from './useFillUpForm';

/**
 * The fill-up form's state, through a receipt scan (#93). The rule itself is
 * `applyScan`, tested in `domain/fillUpForm.test.ts`; this checks the form
 * hands it what it knows — above all, whether the date was set by hand — and
 * fills the typed text the same way it fills the values.
 */

const SCAN_DATE = new Date(2026, 3, 2, 8, 30);
let outcome: ImportOutcome;

vi.mock('./importReceipt', () => ({ importReceiptPhoto: async () => outcome }));
vi.mock('./fuelLog', () => ({ useFuelLog: () => ({ addFillUp: vi.fn(), updateFillUp: vi.fn() }) }));

function readsAs(overrides: Partial<Extract<ImportOutcome, { ok: true }>['suggestion']> = {}): ImportOutcome {
  return {
    ok: true,
    suggestion: {
      gallons: 11.2,
      pricePerGallon: 3.459,
      date: SCAN_DATE,
      station: 'Shell',
      receiptImageData: new Uint8Array([1, 2, 3]),
      note: null,
      ...overrides,
    },
  };
}

function mount() {
  return renderHook(() =>
    useFillUpForm({ vehicleId: 'v1', units: US, existing: [], editing: null, onSaved: async () => {} }),
  ).result;
}

const photo = new File([new Uint8Array([0])], 'receipt.jpg', { type: 'image/jpeg' });

describe('a receipt read into the form', () => {
  test('fills the blanks, values and typed text alike, and takes the receipt’s date', async () => {
    outcome = readsAs();
    const form = mount();
    await act(() => form.current.importPhoto(photo));
    expect(form.current.form.gallons).toBe(11.2);
    expect(form.current.numericText.gallons).toBe('11.2');
    expect(form.current.numericText.price).toBe('3.459');
    expect(form.current.form.date).toEqual(SCAN_DATE);
  });

  test('a date picked by hand stays, whatever the receipt says', async () => {
    outcome = readsAs();
    const form = mount();
    const picked = new Date(2026, 3, 5, 18, 0);
    act(() => form.current.pickDate(picked));
    await act(() => form.current.importPhoto(photo));
    expect(form.current.form.date).toEqual(picked);
    expect(form.current.form.gallons).toBe(11.2);
  });

  test('a price typed first stays as typed, value and text', async () => {
    outcome = readsAs();
    const form = mount();
    act(() => form.current.typeNumber('price', '3.10', (typed) => typed));
    await act(() => form.current.importPhoto(photo));
    expect(form.current.numericText.price).toBe('3.10');
    expect(form.current.form.pricePerGallon).toBe(3.1);
  });

  test('a receipt that could not be read says why and changes nothing', async () => {
    outcome = { ok: false, message: 'That photo could not be read.' };
    const form = mount();
    const before = form.current.form;
    await act(() => form.current.importPhoto(photo));
    expect(form.current.scanNote).toBe('That photo could not be read.');
    expect(form.current.form).toBe(before);
    expect(form.current.scanning).toBe(false);
  });
});
