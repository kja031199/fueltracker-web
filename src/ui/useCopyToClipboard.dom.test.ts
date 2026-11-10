import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useCopyToClipboard } from './useCopyToClipboard';

/** The one clipboard handler (#93): the link panel and the account id each had one. */

const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

function clipboard(value: unknown): void {
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true });
}

afterEach(() => {
  if (original) Object.defineProperty(navigator, 'clipboard', original);
  else Reflect.deleteProperty(navigator, 'clipboard');
});

describe('copying, honestly', () => {
  test('nothing is claimed before a copy is asked for', () => {
    expect(renderHook(() => useCopyToClipboard()).result.current.state).toBe('idle');
  });

  test('a copy that worked says so, with the text it was given', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    clipboard({ writeText });
    const { result } = renderHook(() => useCopyToClipboard());
    await act(() => result.current.copy('hello'));
    expect(writeText).toHaveBeenCalledWith('hello');
    expect(result.current.state).toBe('copied');
  });

  test('no clipboard at all — plain http, an old browser — is a failure, not a success', async () => {
    clipboard(undefined);
    const { result } = renderHook(() => useCopyToClipboard());
    await act(() => result.current.copy('hello'));
    expect(result.current.state).toBe('failed');
  });

  test('a refused write is a failure, and does not throw out of the button', async () => {
    clipboard({ writeText: vi.fn().mockRejectedValue(new Error('denied')) });
    const { result } = renderHook(() => useCopyToClipboard());
    await act(() => result.current.copy('hello'));
    expect(result.current.state).toBe('failed');
  });

  test('a copy after a failure can still succeed', async () => {
    const writeText = vi.fn().mockRejectedValueOnce(new Error('denied')).mockResolvedValueOnce(undefined);
    clipboard({ writeText });
    const { result } = renderHook(() => useCopyToClipboard());
    await act(() => result.current.copy('one'));
    expect(result.current.state).toBe('failed');
    await act(() => result.current.copy('two'));
    expect(result.current.state).toBe('copied');
  });
});
