/**
 * FD-2 — Sustained daemon-outage UX path (T016).
 *
 * Covers the scenario where the daemon stays unreachable across multiple
 * retry attempts: accumulating retry count, persistent error feedback,
 * component remaining visible with no redirect, and eventual recovery
 * clearing all accumulated state.
 */

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

// ── Helpers ─────────────────────────────────────────────────────────────────

const NOW = new Date().toISOString();

function makeMockContext(overrides: Partial<UseSessionResult> = {}): UseSessionResult {
  return {
    session: null,
    isLoading: false,
    pollErrorCount: 0,
    extend: vi.fn(),
    logout: vi.fn(),
    refresh: vi.fn(),
    ...overrides,
  };
}

function daemonSession() {
  return {
    operatorId: 'op-1',
    state: 'daemon-unreachable' as const,
    expiresAt: NOW,
    lastActivityAt: NOW,
    createdAt: NOW,
  };
}

function activeSession() {
  return {
    operatorId: 'op-1',
    state: 'active' as const,
    expiresAt: NOW,
    lastActivityAt: NOW,
    createdAt: NOW,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('FD-2: sustained daemon outage', () => {
  it('accumulates retry count across multiple failed retries', async () => {
    const user = userEvent.setup();
    const refreshFn = vi
      .fn<() => Promise<UseSessionResult['session']>>()
      .mockResolvedValue(daemonSession());

    mockUseSessionContext.mockReturnValue(
      makeMockContext({ session: daemonSession(), refresh: refreshFn }),
    );

    render(<DaemonUnreachable />);

    // Click retry 5 times, each returning daemon-unreachable
    for (let i = 1; i <= 5; i++) {
      await user.click(screen.getByTestId('daemon-unreachable-retry'));

      await waitFor(() => {
        expect(screen.getByTestId('daemon-retry-count')).toHaveTextContent(
          `${String(i)} failed attempt${i === 1 ? '' : 's'}`,
        );
      });
    }

    expect(refreshFn).toHaveBeenCalledTimes(5);
  });

  it('shows still-unavailable message on each failed retry attempt', async () => {
    const user = userEvent.setup();
    const refreshFn = vi
      .fn<() => Promise<UseSessionResult['session']>>()
      .mockResolvedValue(daemonSession());

    mockUseSessionContext.mockReturnValue(
      makeMockContext({ session: daemonSession(), refresh: refreshFn }),
    );

    render(<DaemonUnreachable />);

    await user.click(screen.getByTestId('daemon-unreachable-retry'));

    await waitFor(() => {
      expect(screen.getByTestId('daemon-retry-error')).toHaveTextContent(
        'Hydra daemon is still unavailable',
      );
    });

    // Second retry, same message persists
    await user.click(screen.getByTestId('daemon-unreachable-retry'));

    await waitFor(() => {
      expect(screen.getByTestId('daemon-retry-error')).toHaveTextContent(
        'Hydra daemon is still unavailable',
      );
      expect(screen.getByTestId('daemon-retry-count')).toHaveTextContent('2 failed attempts');
    });
  });

  it('alternates between thrown errors and still-unavailable responses', async () => {
    const user = userEvent.setup();
    const refreshFn = vi.fn<() => Promise<UseSessionResult['session']>>();

    // Alternate: throw, resolve daemon-unreachable, throw
    refreshFn
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(daemonSession())
      .mockRejectedValueOnce(new Error('ETIMEDOUT'));

    mockUseSessionContext.mockReturnValue(
      makeMockContext({ session: daemonSession(), refresh: refreshFn }),
    );

    render(<DaemonUnreachable />);

    // First: thrown error
    await user.click(screen.getByTestId('daemon-unreachable-retry'));
    await waitFor(() => {
      expect(screen.getByTestId('daemon-retry-error')).toHaveTextContent('ECONNREFUSED');
      expect(screen.getByTestId('daemon-retry-count')).toHaveTextContent('1 failed attempt');
    });

    // Second: resolved but still daemon-unreachable
    await user.click(screen.getByTestId('daemon-unreachable-retry'));
    await waitFor(() => {
      expect(screen.getByTestId('daemon-retry-error')).toHaveTextContent(
        'Hydra daemon is still unavailable',
      );
      expect(screen.getByTestId('daemon-retry-count')).toHaveTextContent('2 failed attempts');
    });

    // Third: thrown error
    await user.click(screen.getByTestId('daemon-unreachable-retry'));
    await waitFor(() => {
      expect(screen.getByTestId('daemon-retry-error')).toHaveTextContent('ETIMEDOUT');
      expect(screen.getByTestId('daemon-retry-count')).toHaveTextContent('3 failed attempts');
    });
  });

  it('component remains visible with no redirect during sustained outage', async () => {
    const user = userEvent.setup();
    const originalHref = window.location.href;

    const refreshFn = vi
      .fn<() => Promise<UseSessionResult['session']>>()
      .mockResolvedValue(daemonSession());

    mockUseSessionContext.mockReturnValue(
      makeMockContext({ session: daemonSession(), refresh: refreshFn }),
    );

    render(<DaemonUnreachable />);

    // Multiple retries
    for (let i = 0; i < 3; i++) {
      await user.click(screen.getByTestId('daemon-unreachable-retry'));
      await waitFor(() => {
        expect(screen.getByTestId('daemon-unreachable-retry')).not.toBeDisabled();
      });
    }

    // Component still visible, no redirect
    expect(screen.getByTestId('daemon-unreachable')).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(window.location.href).toBe(originalHref);
  });

  it('eventual recovery clears all accumulated retry state', async () => {
    const user = userEvent.setup();
    const refreshFn = vi.fn<() => Promise<UseSessionResult['session']>>();

    // First 3 retries fail, 4th succeeds
    refreshFn
      .mockResolvedValueOnce(daemonSession())
      .mockResolvedValueOnce(daemonSession())
      .mockResolvedValueOnce(daemonSession())
      .mockImplementation(async () => {
        mockUseSessionContext.mockReturnValue(
          makeMockContext({ session: activeSession(), refresh: refreshFn }),
        );
        return activeSession();
      });

    mockUseSessionContext.mockReturnValue(
      makeMockContext({ session: daemonSession(), refresh: refreshFn }),
    );

    render(<DaemonUnreachable />);

    // Build up 3 failures
    for (let i = 1; i <= 3; i++) {
      await user.click(screen.getByTestId('daemon-unreachable-retry'));
      await waitFor(() => {
        expect(screen.getByTestId('daemon-retry-count')).toHaveTextContent(
          `${String(i)} failed attempt`,
        );
      });
    }

    // 4th retry succeeds → component hides
    await user.click(screen.getByTestId('daemon-unreachable-retry'));

    await waitFor(() => {
      expect(screen.queryByTestId('daemon-unreachable')).not.toBeInTheDocument();
    });

    // Verify all error/retry state is gone
    expect(screen.queryByTestId('daemon-retry-error')).not.toBeInTheDocument();
    expect(screen.queryByTestId('daemon-retry-count')).not.toBeInTheDocument();
  });

  it('session-active message is preserved during sustained outage', () => {
    mockUseSessionContext.mockReturnValue(
      makeMockContext({ session: daemonSession() }),
    );

    render(<DaemonUnreachable />);

    // The component should reassure the operator that their session is valid
    expect(screen.getByText(/session is still active/i)).toBeInTheDocument();
  });
});
