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

function renderBanner(overrides: Partial<WorkspaceConnectionState> = {}) {
  const props: ConnectionBannerProps = {
    connection: connectionState(overrides),
  };
  return render(<ConnectionBanner {...props} />);
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
  it('shows a status banner when daemon is unavailable', () => {
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
