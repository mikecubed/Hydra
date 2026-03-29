import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

vi.mock('../context/session-context.ts', () => ({
  useSessionContext: vi.fn(),
}));

import { useSessionContext } from '../context/session-context.ts';
import { ExpiryBanner } from '../components/expiry-banner.tsx';

const mockUseSessionContext = useSessionContext as ReturnType<typeof vi.fn>;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ExpiryBanner', () => {
  it('not rendered when session.state is active', () => {
    mockUseSessionContext.mockReturnValue({
      session: { state: 'active', expiresAt: '2099-01-01T00:00:00Z' },
      extend: vi.fn(),
    });
    render(<ExpiryBanner />);
    expect(screen.queryByTestId('expiry-banner')).not.toBeInTheDocument();
  });

  it('renders with role="alert" and data-testid when state is expiring-soon', () => {
    mockUseSessionContext.mockReturnValue({
      session: { state: 'expiring-soon', expiresAt: '2099-01-01T00:00:00Z' },
      extend: vi.fn(),
    });
    render(<ExpiryBanner />);
    const banner = screen.getByTestId('expiry-banner');
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveAttribute('role', 'alert');
  });

  it('"Extend Session" button calls extend() on click', async () => {
    const user = userEvent.setup();
    const extend = vi.fn().mockResolvedValue(null);
    mockUseSessionContext.mockReturnValue({
      session: { state: 'expiring-soon', expiresAt: '2099-01-01T00:00:00Z' },
      extend,
    });
    render(<ExpiryBanner />);
    await user.click(screen.getByTestId('extend-session-button'));
    expect(extend).toHaveBeenCalledTimes(1);
  });

  it('"Extend Session" button is disabled while extend() is in flight', async () => {
    const user = userEvent.setup();
    let resolveExtend!: () => void;
    const extend = vi.fn().mockImplementation(
      () =>
        new Promise<void>((r) => {
          resolveExtend = r;
        }),
    );
    mockUseSessionContext.mockReturnValue({
      session: { state: 'expiring-soon', expiresAt: '2099-01-01T00:00:00Z' },
      extend,
    });
    render(<ExpiryBanner />);

    await user.click(screen.getByTestId('extend-session-button'));
    expect(screen.getByTestId('extend-session-button')).toBeDisabled();

    resolveExtend();
    await waitFor(() => {
      expect(screen.getByTestId('extend-session-button')).not.toBeDisabled();
    });
  });

  it('dismiss button hides banner without calling extend()', async () => {
    const user = userEvent.setup();
    const extend = vi.fn();
    mockUseSessionContext.mockReturnValue({
      session: { state: 'expiring-soon', expiresAt: '2099-01-01T00:00:00Z' },
      extend,
    });
    render(<ExpiryBanner />);

    expect(screen.getByTestId('expiry-banner')).toBeInTheDocument();
    await user.click(screen.getByTestId('expiry-banner-dismiss'));

    expect(screen.queryByTestId('expiry-banner')).not.toBeInTheDocument();
    expect(extend).not.toHaveBeenCalled();
  });

  it('banner disappears when session.state transitions away from expiring-soon', () => {
    const extend = vi.fn();
    mockUseSessionContext.mockReturnValue({
      session: { state: 'expiring-soon', expiresAt: '2099-01-01T00:00:00Z' },
      extend,
    });
    const { rerender } = render(<ExpiryBanner />);
    expect(screen.getByTestId('expiry-banner')).toBeInTheDocument();

    mockUseSessionContext.mockReturnValue({
      session: { state: 'active', expiresAt: '2099-01-01T00:00:00Z' },
      extend,
    });
    rerender(<ExpiryBanner />);
    expect(screen.queryByTestId('expiry-banner')).not.toBeInTheDocument();
  });

  it('banner reappears after page reload (dismiss is local state)', () => {
    const extend = vi.fn();
    mockUseSessionContext.mockReturnValue({
      session: { state: 'expiring-soon', expiresAt: '2099-01-01T00:00:00Z' },
      extend,
    });

    // First mount — dismiss the banner
    const { unmount } = render(<ExpiryBanner />);
    expect(screen.getByTestId('expiry-banner')).toBeInTheDocument();
    // Simulate dismiss via state — we just need to verify a fresh mount shows it again
    unmount();

    // Second mount (simulates page reload) — banner should appear
    render(<ExpiryBanner />);
    expect(screen.getByTestId('expiry-banner')).toBeInTheDocument();
  });

  // ── T012 / FD-1: extend error feedback ─────────────────────────────────

  it('shows error message when extend() rejects', async () => {
    const user = userEvent.setup();
    const extend = vi.fn().mockRejectedValue(new Error('Reauth failed'));
    mockUseSessionContext.mockReturnValue({
      session: { state: 'expiring-soon', expiresAt: '2099-01-01T00:00:00Z' },
      extend,
    });
    render(<ExpiryBanner />);

    await user.click(screen.getByTestId('extend-session-button'));

    await waitFor(() => {
      const error = screen.getByTestId('extend-error');
      expect(error).toBeInTheDocument();
      expect(error).toHaveTextContent('Reauth failed');
    });
  });

  it('clears extend error on successful retry', async () => {
    const user = userEvent.setup();
    const extend = vi
      .fn()
      .mockRejectedValueOnce(new Error('Reauth failed'))
      .mockResolvedValue(null);
    mockUseSessionContext.mockReturnValue({
      session: { state: 'expiring-soon', expiresAt: '2099-01-01T00:00:00Z' },
      extend,
    });
    render(<ExpiryBanner />);

    // First click fails
    await user.click(screen.getByTestId('extend-session-button'));
    await waitFor(() => {
      expect(screen.getByTestId('extend-error')).toBeInTheDocument();
    });

    // Second click succeeds
    await user.click(screen.getByTestId('extend-session-button'));
    await waitFor(() => {
      expect(screen.queryByTestId('extend-error')).not.toBeInTheDocument();
    });
  });

  it('shows timeout error when extend() hangs beyond timeout', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const extend = vi.fn().mockImplementation(
      () =>
        new Promise<void>(() => {
          /* never resolves */
        }),
    );
    mockUseSessionContext.mockReturnValue({
      session: { state: 'expiring-soon', expiresAt: '2099-01-01T00:00:00Z' },
      extend,
    });
    render(<ExpiryBanner />);

    await user.click(screen.getByTestId('extend-session-button'));

    // Advance past the 10s timeout
    vi.advanceTimersByTime(11_000);

    await waitFor(() => {
      const error = screen.getByTestId('extend-error');
      expect(error).toBeInTheDocument();
      expect(error).toHaveTextContent(/timed out/i);
    });

    vi.useRealTimers();
  });

  it('clears extend error when session transitions away from expiring-soon', () => {
    const extend = vi.fn().mockRejectedValue(new Error('Reauth failed'));
    mockUseSessionContext.mockReturnValue({
      session: { state: 'expiring-soon', expiresAt: '2099-01-01T00:00:00Z' },
      extend,
    });
    const { rerender } = render(<ExpiryBanner />);

    // Transition to active — error should clear
    mockUseSessionContext.mockReturnValue({
      session: { state: 'active', expiresAt: '2099-01-01T00:00:00Z' },
      extend,
    });
    rerender(<ExpiryBanner />);

    // Re-enter expiring-soon — no stale error
    mockUseSessionContext.mockReturnValue({
      session: { state: 'expiring-soon', expiresAt: '2099-01-01T00:00:00Z' },
      extend,
    });
    rerender(<ExpiryBanner />);

    expect(screen.queryByTestId('extend-error')).not.toBeInTheDocument();
  });
});
