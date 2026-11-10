import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

/**
 * One test's setup never reaches the next (#97).
 *
 * The config does this, so no file has to remember to: React Testing Library
 * unmounts after every test (its own `afterEach`, registered because `globals`
 * is on), and `restoreMocks`, `unstubGlobals` and `unstubEnvs` put spies,
 * globals and `import.meta.env` back before every test. It used to be written
 * by hand — an after-each `cleanup` in 25 files — and where it wasn't, it leaked:
 * `importReceipt`'s tests replaced `HTMLCanvasElement.prototype.toBlob` and
 * never put it back.
 *
 * The tests run in order, so the second checks what the first left behind.
 * This file is in the `dom` project by its `.tsx` name, with no docblock: that
 * it has a `document` at all is the project choosing its environment.
 */

const ORIGINAL_TO_BLOB = HTMLCanvasElement.prototype.toBlob;

describe('isolation between tests', () => {
  test('a test that renders, stubs, spies and sets env', () => {
    render(<p>left behind?</p>);
    vi.stubGlobal('leakedGlobal', 'yes');
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(() => {});
    vi.stubEnv('VITE_LEAKED', 'yes');

    expect(screen.getByText('left behind?')).toBeInTheDocument();
    expect((globalThis as Record<string, unknown>).leakedGlobal).toBe('yes');
    expect(HTMLCanvasElement.prototype.toBlob).not.toBe(ORIGINAL_TO_BLOB);
    expect(import.meta.env.VITE_LEAKED).toBe('yes');
  });

  test('finds none of it in the next one', () => {
    expect(screen.queryByText('left behind?')).toBeNull();
    expect(document.body.innerHTML).toBe('');
    expect('leakedGlobal' in globalThis).toBe(false);
    expect(HTMLCanvasElement.prototype.toBlob).toBe(ORIGINAL_TO_BLOB);
    expect(import.meta.env.VITE_LEAKED).toBeUndefined();
  });
});
