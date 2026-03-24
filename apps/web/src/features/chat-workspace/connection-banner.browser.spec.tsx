import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { ConnectionBanner, type ConnectionBannerProps } from './components/connection-banner.tsx';
import type { WorkspaceConnectionState } from '../../shared/session-state.ts';
import { initialConnectionState } from '../../shared/session-state.ts';

afterEach(() => {
  cleanup();
});

function connectionState(
  overrides: Partial<WorkspaceConnectionState> = {},
): WorkspaceConnectionState {
  return { ...initialConnectionState(), ...overrides };
}

function renderBanner(
  overrides: Partial<WorkspaceConnectionState> = {},
  convergenceHint?: string | null,
  staleControlReason?: string | null,
) {
  return render(
    <ConnectionBanner
      connection={connectionState(overrides)}
      convergenceHint={convergenceHint}
      staleControlReason={staleControlReason}
    />,
  );
}

// ─── Visibility: hidden when operational ────────────────────────────────────

describe('ConnectionBanner hidden states', () => {
  it('renders nothing when fully operational', () => {
    renderBanner({ transportStatus: 'live', syncStatus: 'idle', daemonStatus: 'healthy' });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('renders nothing when operational with recovered sync', () => {
    renderBanner({ transportStatus: 'live', syncStatus: 'recovered', daemonStatus: 'healthy' });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });
});

// ─── Visibility: transport/reconnect states ─────────────────────────────────

describe('ConnectionBanner transport states', () => {
  it('shows a status banner while connecting', () => {
    renderBanner({ transportStatus: 'connecting' });
    const el = screen.getByRole('status');
    expect(el).toBeInTheDocument();
    expect(el).toHaveTextContent(/connecting/i);
  });

  it('shows a status banner while reconnecting', () => {
    renderBanner({ transportStatus: 'reconnecting', reconnectAttempt: 2 });
    const el = screen.getByRole('status');
    expect(el).toBeInTheDocument();
    expect(el).toHaveTextContent(/reconnecting/i);
    expect(el).toHaveTextContent(/attempt 2/i);
  });

  it('shows an alert banner when disconnected after exhausted retries', () => {
    renderBanner({ transportStatus: 'disconnected', reconnectAttempt: 5 });
    const el = screen.getByRole('alert');
    expect(el).toBeInTheDocument();
    expect(el).toHaveTextContent(/disconnected/i);
  });

  it('shows an alert banner when session is expired', () => {
    renderBanner({ transportStatus: 'live', sessionStatus: 'expired' });
    const el = screen.getByRole('alert');
    expect(el).toBeInTheDocument();
    expect(el).toHaveTextContent(/expired/i);
    expect(el).toHaveTextContent(/sign in/i);
  });

  it('shows an alert banner when session is invalidated', () => {
    renderBanner({ transportStatus: 'live', sessionStatus: 'invalidated' });
    const el = screen.getByRole('alert');
    expect(el).toBeInTheDocument();
    expect(el).toHaveTextContent(/invalidated/i);
    expect(el).toHaveTextContent(/sign in/i);
  });
});

// ─── Visibility: daemon/sync/session-warning states ─────────────────────────

describe('ConnectionBanner daemon/sync states', () => {
  it('shows an alert banner when daemon is unavailable', () => {
    renderBanner({
      transportStatus: 'live',
      syncStatus: 'idle',
      daemonStatus: 'unavailable',
    });
    const el = screen.getByRole('alert');
    expect(el).toBeInTheDocument();
    expect(el).toHaveTextContent(/daemon.*unavailable/i);
  });

  it('shows a status banner when daemon is recovering', () => {
    renderBanner({
      transportStatus: 'live',
      syncStatus: 'idle',
      daemonStatus: 'recovering',
    });
    const el = screen.getByRole('status');
    expect(el).toBeInTheDocument();
    expect(el).toHaveTextContent(/daemon.*recovering/i);
  });

  it('shows an alert on sync error', () => {
    renderBanner({
      transportStatus: 'live',
      syncStatus: 'error',
      daemonStatus: 'healthy',
    });
    const el = screen.getByRole('alert');
    expect(el).toBeInTheDocument();
    expect(el).toHaveTextContent(/sync error/i);
  });

  it('shows a warning when session is expiring soon', () => {
    renderBanner({
      transportStatus: 'live',
      syncStatus: 'idle',
      daemonStatus: 'healthy',
      sessionStatus: 'expiring-soon',
    });
    const el = screen.getByRole('status');
    expect(el).toBeInTheDocument();
    expect(el).toHaveTextContent(/expiring soon/i);
  });

  it('shows a status banner while syncing', () => {
    renderBanner({
      transportStatus: 'live',
      syncStatus: 'syncing',
      daemonStatus: 'healthy',
    });
    const el = screen.getByRole('status');
    expect(el).toBeInTheDocument();
    expect(el).toHaveTextContent(/synchronizing/i);
  });
});

// ─── ARIA / Accessibility ───────────────────────────────────────────────────

describe('ConnectionBanner accessibility', () => {
  it('uses aria-live="polite" for non-critical states', () => {
    renderBanner({ transportStatus: 'connecting' });
    const el = screen.getByRole('status');
    expect(el).toHaveAttribute('aria-live', 'polite');
  });

  it('uses aria-live="assertive" for alert states', () => {
    renderBanner({ transportStatus: 'disconnected', reconnectAttempt: 3 });
    const el = screen.getByRole('alert');
    expect(el).toHaveAttribute('aria-live', 'assertive');
  });
});

// ─── Stale-control awareness ────────────────────────────────────────────────

describe('ConnectionBanner stale-control awareness', () => {
  it('shows a status banner when convergenceHint is provided and connection is operational', () => {
    renderBanner(
      { transportStatus: 'live', syncStatus: 'idle', daemonStatus: 'healthy' },
      'Another session modified this conversation',
    );
    const el = screen.getByRole('status');
    expect(el).toBeInTheDocument();
    expect(el).toHaveTextContent(/another session/i);
  });

  it('renders nothing when convergenceHint is null and connection is operational', () => {
    renderBanner({ transportStatus: 'live', syncStatus: 'idle', daemonStatus: 'healthy' }, null);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('uses polite aria-live for convergence hint (not assertive)', () => {
    renderBanner(
      { transportStatus: 'live', syncStatus: 'idle', daemonStatus: 'healthy' },
      'Controls may be outdated',
    );
    const el = screen.getByRole('status');
    expect(el).toHaveAttribute('aria-live', 'polite');
  });

  it('combines connection message with convergence hint when both present', () => {
    renderBanner(
      { transportStatus: 'disconnected', reconnectAttempt: 5 },
      'Another session modified this conversation',
    );
    const el = screen.getByRole('alert');
    expect(el).toBeInTheDocument();
    expect(el).toHaveTextContent(/disconnected/i);
    expect(el).toHaveTextContent(/another session/i);
  });

  it('shows a warning banner when staleControlReason is provided on an operational connection', () => {
    renderBanner(
      { transportStatus: 'live', syncStatus: 'idle', daemonStatus: 'healthy' },
      null,
      'Task was cancelled by another session',
    );
    const el = screen.getByRole('status');
    expect(el).toBeInTheDocument();
    expect(el).toHaveTextContent(/cancelled by another session/i);
    // Warning severity → polite (not assertive)
    expect(el).toHaveAttribute('aria-live', 'polite');
  });

  it('staleControlReason takes precedence over convergenceHint when both are present', () => {
    renderBanner(
      { transportStatus: 'live', syncStatus: 'idle', daemonStatus: 'healthy' },
      'Controls updated by another session',
      'Task was cancelled by another session',
    );
    const el = screen.getByRole('status');
    expect(el).toBeInTheDocument();
    // staleControlReason message wins
    expect(el).toHaveTextContent(/cancelled by another session/i);
    // convergenceHint message is NOT displayed
    expect(el).not.toHaveTextContent(/controls updated/i);
  });

  it('staleControlReason appends to connection message on a degraded connection', () => {
    renderBanner(
      { transportStatus: 'disconnected', reconnectAttempt: 5 },
      'Controls updated by another session',
      'Task was cancelled by another session',
    );
    const el = screen.getByRole('alert');
    expect(el).toBeInTheDocument();
    // Connection message + staleControlReason (not convergenceHint)
    expect(el).toHaveTextContent(/disconnected/i);
    expect(el).toHaveTextContent(/cancelled by another session/i);
    expect(el).not.toHaveTextContent(/controls updated/i);
  });
});

// ─── Multi-session convergence hint ─────────────────────────────────────────

describe('ConnectionBanner convergence hint', () => {
  it('shows convergence hint when provided on an operational connection', () => {
    const props: ConnectionBannerProps = {
      connection: connectionState({
        transportStatus: 'live',
        syncStatus: 'idle',
        daemonStatus: 'healthy',
      }),
      convergenceHint: 'Controls updated by another session',
    };
    render(<ConnectionBanner {...props} />);
    const el = screen.getByRole('status');
    expect(el).toBeInTheDocument();
    expect(el).toHaveTextContent(/another session/i);
  });

  it('renders nothing when fully operational with no convergence hint', () => {
    const props: ConnectionBannerProps = {
      connection: connectionState({
        transportStatus: 'live',
        syncStatus: 'idle',
        daemonStatus: 'healthy',
      }),
      convergenceHint: null,
    };
    render(<ConnectionBanner {...props} />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows convergence hint alongside degraded connection message', () => {
    const props: ConnectionBannerProps = {
      connection: connectionState({
        transportStatus: 'live',
        syncStatus: 'syncing',
        daemonStatus: 'healthy',
      }),
      convergenceHint: 'Some controls are stale',
    };
    render(<ConnectionBanner {...props} />);
    const el = screen.getByRole('status');
    expect(el).toBeInTheDocument();
    // Should show both sync message and convergence hint
    expect(el).toHaveTextContent(/stale/i);
  });

  it('uses info severity for convergence-only banner', () => {
    const props: ConnectionBannerProps = {
      connection: connectionState({
        transportStatus: 'live',
        syncStatus: 'idle',
        daemonStatus: 'healthy',
      }),
      convergenceHint: 'Workspace synchronized from another session',
    };
    render(<ConnectionBanner {...props} />);
    const el = screen.getByRole('status');
    expect(el).toHaveAttribute('aria-live', 'polite');
  });
});
