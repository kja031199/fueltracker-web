// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmButton, type ConfirmButtonProps } from './ConfirmButton';

/** The one confirm-then-act pair (#93): three hand-written copies before. */

afterEach(cleanup);

function setUp(overrides: Partial<ConfirmButtonProps> = {}) {
  const props = {
    asking: false,
    onAsk: vi.fn(),
    onCancel: vi.fn(),
    onConfirm: vi.fn(),
    label: 'Delete',
    confirmLabel: 'Delete this fill-up',
    cancelLabel: 'Keep',
    ...overrides,
  };
  render(<ConfirmButton {...props} />);
  return props;
}

describe('a button that asks before it acts', () => {
  test('not asking: only the first button, and pressing it asks — it does not act', async () => {
    const props = setUp();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Delete' }));
    expect(props.onAsk).toHaveBeenCalledTimes(1);
    expect(props.onConfirm).not.toHaveBeenCalled();
    expect(props.onCancel).not.toHaveBeenCalled();
  });

  test('asking: the act and the way out, and only the act acts', async () => {
    const user = userEvent.setup();
    const props = setUp({ asking: true });
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Keep' }));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
    expect(props.onConfirm).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Delete this fill-up' }));
    expect(props.onConfirm).toHaveBeenCalledTimes(1);
    expect(props.onAsk).not.toHaveBeenCalled();
  });

  test('the act always looks dangerous; the first button looks as dangerous as it is', () => {
    setUp({ tone: 'secondary', label: 'Leave' });
    expect(screen.getByRole('button', { name: 'Leave' }).className).toContain('button--secondary');
    cleanup();
    setUp();
    expect(screen.getByRole('button', { name: 'Delete' }).className).toContain('button--danger');
    cleanup();
    setUp({ asking: true, tone: 'secondary' });
    expect(screen.getByRole('button', { name: 'Delete this fill-up' }).className).toContain('button--danger');
    expect(screen.getByRole('button', { name: 'Keep' }).className).toContain('button--secondary');
  });
});
