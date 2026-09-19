// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ServiceWorkerState } from './useServiceWorker';
import { UpdateBanner } from './UpdateBanner';

afterEach(cleanup);

const state = (overrides: Partial<ServiceWorkerState> = {}): ServiceWorkerState => ({
  updateReady: false,
  offlineReady: false,
  update: () => {},
  dismissOfflineReady: () => {},
  ...overrides,
});

describe('the update banner', () => {
  test('shows nothing when there is nothing to say', () => {
    const { container } = render(<UpdateBanner state={state()} />);
    expect(container).toBeEmptyDOMElement();
  });

  test('offers a reload rather than performing one', () => {
    // An automatic update would reload mid-entry and discard a fill-up someone
    // was halfway through. Since this app holds the only copy of their data,
    // it asks.
    const update = vi.fn();
    render(<UpdateBanner state={state({ updateReady: true, update })} />);
    expect(screen.getByRole('status')).toHaveTextContent(/new version is ready/i);
    expect(update).not.toHaveBeenCalled();
  });

  test('reloads when asked', async () => {
    const user = userEvent.setup();
    const update = vi.fn();
    render(<UpdateBanner state={state({ updateReady: true, update })} />);
    await user.click(screen.getByRole('button', { name: /reload/i }));
    expect(update).toHaveBeenCalledOnce();
  });

  test('says when the app will work offline, and can be dismissed', async () => {
    const user = userEvent.setup();
    const dismiss = vi.fn();
    render(<UpdateBanner state={state({ offlineReady: true, dismissOfflineReady: dismiss })} />);
    expect(screen.getByRole('status')).toHaveTextContent(/ready to work offline/i);
    await user.click(screen.getByRole('button', { name: /got it/i }));
    expect(dismiss).toHaveBeenCalledOnce();
  });

  test('an available update takes precedence over the offline note', () => {
    render(<UpdateBanner state={state({ updateReady: true, offlineReady: true })} />);
    expect(screen.getByRole('status')).toHaveTextContent(/new version/i);
    expect(screen.queryByText(/work offline/i)).not.toBeInTheDocument();
  });

  test('announces without interrupting', () => {
    // status, not alert: neither of these is worth seizing a screen reader
    // mid-sentence to say.
    render(<UpdateBanner state={state({ updateReady: true })} />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
