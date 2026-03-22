import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';

/**
 * Mock TanStack Router's Outlet so AppShell renders without a full router.
 * vi.mock is hoisted — factory must be self-contained.
 */
vi.mock('@tanstack/react-router', () => ({
  Outlet: () => createElement('div', { 'data-testid': 'outlet' }, 'child route'),
}));

import { AppShell, ConnectionStateContext } from './app-shell.tsx';
import type { WorkspaceConnectionState } from '../shared/session-state.ts';
import { initialConnectionState } from '../shared/session-state.ts';

afterEach(() => {
  cleanup();
});

function connectionState(
  overrides: Partial<WorkspaceConnectionState> = {},
): WorkspaceConnectionState {
  return { ...initialConnectionState(), ...overrides };
}

describe('AppShell connection banner integration', () => {
  it('renders no banner when no connection context is provided', () => {
    render(<AppShell />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    // Outlet still renders
    expect(screen.getByTestId('outlet')).toBeInTheDocument();
  });

  it('renders no banner when connection is fully operational', () => {
    const conn = connectionState({
      transportStatus: 'live',
      syncStatus: 'idle',
      daemonStatus: 'healthy',
    });
    render(
      <ConnectionStateContext.Provider value={conn}>
        <AppShell />
      </ConnectionStateContext.Provider>,
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('renders a connection banner between header and main when reconnecting', () => {
    const conn = connectionState({
      transportStatus: 'reconnecting',
      reconnectAttempt: 1,
    });
    render(
      <ConnectionStateContext.Provider value={conn}>
        <AppShell />
      </ConnectionStateContext.Provider>,
    );
    const banner = screen.getByRole('status');
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent(/reconnecting/i);

    // Banner should appear before main content in DOM order
    const header = screen.getByRole('banner');
    const main = screen.getByRole('main');
    const bannerPosition = banner.compareDocumentPosition(main);
    const headerPosition = header.compareDocumentPosition(banner);
    // Banner follows header (DOCUMENT_POSITION_FOLLOWING = 4)
    expect(headerPosition & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Banner precedes main (DOCUMENT_POSITION_FOLLOWING = 4)
    expect(bannerPosition & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders an alert when session is terminal', () => {
    const conn = connectionState({ sessionStatus: 'expired' });
    render(
      <ConnectionStateContext.Provider value={conn}>
        <AppShell />
      </ConnectionStateContext.Provider>,
    );
    const banner = screen.getByRole('alert');
    expect(banner).toHaveTextContent(/expired/i);
  });

  it('still renders the Outlet alongside the banner', () => {
    const conn = connectionState({ transportStatus: 'connecting' });
    render(
      <ConnectionStateContext.Provider value={conn}>
        <AppShell />
      </ConnectionStateContext.Provider>,
    );
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByTestId('outlet')).toBeInTheDocument();
  });
});
