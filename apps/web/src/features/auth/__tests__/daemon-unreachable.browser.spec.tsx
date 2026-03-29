import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

vi.mock('../context/session-context.ts', () => ({
  useSessionContext: vi.fn(),
}));

import { useSessionContext } from '../context/session-context.ts';
import { DaemonUnreachable } from '../components/daemon-unreachable.tsx';
import type { UseSessionResult } from '../hooks/use-session.ts';

const mockUseSessionContext = useSessionContext as ReturnType<typeof vi.fn>;

function makeMockContext(overrides: Partial<UseSessionResult> = {}): UseSessionResult {
  return {
    session: null,
    isLoading: false,
    extend: vi.fn(),
    logout: vi.fn(),
    refresh: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('DaemonUnreachable', () => {
  it('renders with role="status" and data-testid when state is daemon-unreachable', () => {
    mockUseSessionContext.mockReturnValue(
      makeMockContext({
        session: {
          operatorId: 'op-1',
          state: 'daemon-unreachable',
          expiresAt: new Date().toISOString(),
          lastActivityAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        },
      }),
    );

    render(<DaemonUnreachable />);

    const el = screen.getByTestId('daemon-unreachable');
    expect(el).toBeInTheDocument();
    expect(el).toHaveAttribute('role', 'status');
  });

  it('not rendered when state is active or expiring-soon', () => {
    for (const state of ['active', 'expiring-soon'] as const) {
      mockUseSessionContext.mockReturnValue(
        makeMockContext({
          session: {
            operatorId: 'op-1',
            state,
            expiresAt: new Date().toISOString(),
            lastActivityAt: new Date().toISOString(),
            createdAt: new Date().toISOString(),
          },
        }),
      );

      const { unmount } = render(<DaemonUnreachable />);
      expect(screen.queryByTestId('daemon-unreachable')).not.toBeInTheDocument();
      unmount();
    }
  });

  it('retry button calls refresh() and updates state on recovery', async () => {
    const user = userEvent.setup();
    const refreshFn = vi.fn<() => Promise<void>>();

    const daemonSession = {
      operatorId: 'op-1',
      state: 'daemon-unreachable' as const,
      expiresAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };

    const activeSession = { ...daemonSession, state: 'active' as const };

    // First render: daemon-unreachable. After refresh resolves, switch to active.
    refreshFn.mockImplementation(async () => {
      mockUseSessionContext.mockReturnValue(
        makeMockContext({ session: activeSession, refresh: refreshFn }),
      );
    });

    mockUseSessionContext.mockReturnValue(
      makeMockContext({ session: daemonSession, refresh: refreshFn }),
    );

    render(<DaemonUnreachable />);
    expect(screen.getByTestId('daemon-unreachable')).toBeInTheDocument();

    await user.click(screen.getByTestId('daemon-unreachable-retry'));

    expect(refreshFn).toHaveBeenCalledTimes(1);

    await waitFor(() => {
      expect(screen.queryByTestId('daemon-unreachable')).not.toBeInTheDocument();
    });
  });

  it('retry button is disabled while refresh() is in flight', async () => {
    const user = userEvent.setup();

    let resolveRefresh!: () => void;
    const refreshFn = vi.fn<() => Promise<void>>(
      () =>
        new Promise<void>((r) => {
          resolveRefresh = r;
        }),
    );

    mockUseSessionContext.mockReturnValue(
      makeMockContext({
        session: {
          operatorId: 'op-1',
          state: 'daemon-unreachable',
          expiresAt: new Date().toISOString(),
          lastActivityAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        },
        refresh: refreshFn,
      }),
    );

    render(<DaemonUnreachable />);

    const btn = screen.getByTestId('daemon-unreachable-retry');
    await user.click(btn);

    expect(btn).toBeDisabled();

    resolveRefresh();

    await waitFor(() => {
      expect(screen.getByTestId('daemon-unreachable-retry')).not.toBeDisabled();
    });
  });

  it('retry button has accessible label', () => {
    mockUseSessionContext.mockReturnValue(
      makeMockContext({
        session: {
          operatorId: 'op-1',
          state: 'daemon-unreachable',
          expiresAt: new Date().toISOString(),
          lastActivityAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        },
      }),
    );

    render(<DaemonUnreachable />);

    const btn = screen.getByTestId('daemon-unreachable-retry');
    expect(btn).toHaveAttribute('aria-label', 'Check again');
    expect(btn).toHaveTextContent('Check again');
  });

  it('does not redirect to /login', async () => {
    const user = userEvent.setup();
    const originalHref = window.location.href;

    const refreshFn = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('fail'));

    mockUseSessionContext.mockReturnValue(
      makeMockContext({
        session: {
          operatorId: 'op-1',
          state: 'daemon-unreachable',
          expiresAt: new Date().toISOString(),
          lastActivityAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        },
        refresh: refreshFn,
      }),
    );

    render(<DaemonUnreachable />);

    await user.click(screen.getByTestId('daemon-unreachable-retry'));

    await waitFor(() => {
      expect(screen.getByTestId('daemon-unreachable-retry')).not.toBeDisabled();
    });

    // Component should still be rendered (no redirect)
    expect(screen.getByTestId('daemon-unreachable')).toBeInTheDocument();
    expect(window.location.href).toBe(originalHref);
  });

  // ── T012 / FD-2: retry error feedback ──────────────────────────────────

  it('shows error message when retry fails', async () => {
    const user = userEvent.setup();
    const refreshFn = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error('Connection refused'));

    mockUseSessionContext.mockReturnValue(
      makeMockContext({
        session: {
          operatorId: 'op-1',
          state: 'daemon-unreachable',
          expiresAt: new Date().toISOString(),
          lastActivityAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        },
        refresh: refreshFn,
      }),
    );

    render(<DaemonUnreachable />);
    await user.click(screen.getByTestId('daemon-unreachable-retry'));

    await waitFor(() => {
      const error = screen.getByTestId('daemon-retry-error');
      expect(error).toBeInTheDocument();
      expect(error).toHaveTextContent('Connection refused');
    });
  });

  it('shows retry attempt count after failed retries', async () => {
    const user = userEvent.setup();
    const refreshFn = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('fail'));

    mockUseSessionContext.mockReturnValue(
      makeMockContext({
        session: {
          operatorId: 'op-1',
          state: 'daemon-unreachable',
          expiresAt: new Date().toISOString(),
          lastActivityAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        },
        refresh: refreshFn,
      }),
    );

    render(<DaemonUnreachable />);

    // No retry count initially
    expect(screen.queryByTestId('daemon-retry-count')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('daemon-unreachable-retry'));
    await waitFor(() => {
      expect(screen.getByTestId('daemon-retry-count')).toHaveTextContent('1 failed attempt');
    });

    await user.click(screen.getByTestId('daemon-unreachable-retry'));
    await waitFor(() => {
      expect(screen.getByTestId('daemon-retry-count')).toHaveTextContent('2 failed attempts');
    });
  });

  it('clears error message on successful retry after failure', async () => {
    const user = userEvent.setup();
    const refreshFn = vi.fn<() => Promise<void>>();

    const daemonSession = {
      operatorId: 'op-1',
      state: 'daemon-unreachable' as const,
      expiresAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };

    const activeSession = { ...daemonSession, state: 'active' as const };

    // First retry fails, second succeeds
    refreshFn.mockRejectedValueOnce(new Error('fail')).mockImplementation(async () => {
      mockUseSessionContext.mockReturnValue(
        makeMockContext({ session: activeSession, refresh: refreshFn }),
      );
    });

    mockUseSessionContext.mockReturnValue(
      makeMockContext({ session: daemonSession, refresh: refreshFn }),
    );

    render(<DaemonUnreachable />);

    // First click fails — error shown
    await user.click(screen.getByTestId('daemon-unreachable-retry'));
    await waitFor(() => {
      expect(screen.getByTestId('daemon-retry-error')).toBeInTheDocument();
    });

    // Second click succeeds — component hides
    await user.click(screen.getByTestId('daemon-unreachable-retry'));
    await waitFor(() => {
      expect(screen.queryByTestId('daemon-unreachable')).not.toBeInTheDocument();
    });
  });

  it('shows explicit feedback when refresh succeeds but daemon remains unavailable', async () => {
    const user = userEvent.setup();
    const refreshFn = vi.fn<() => Promise<void>>().mockResolvedValue();

    mockUseSessionContext.mockReturnValue(
      makeMockContext({
        session: {
          operatorId: 'op-1',
          state: 'daemon-unreachable',
          expiresAt: new Date().toISOString(),
          lastActivityAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        },
        refresh: refreshFn,
      }),
    );

    render(<DaemonUnreachable />);

    await user.click(screen.getByTestId('daemon-unreachable-retry'));

    await waitFor(() => {
      expect(screen.getByTestId('daemon-retry-error')).toHaveTextContent(
        'Hydra daemon is still unavailable. Try again shortly.',
      );
      expect(screen.getByTestId('daemon-retry-count')).toHaveTextContent('1 failed attempt');
    });
  });
});
