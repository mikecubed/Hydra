import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

vi.mock('../hooks/use-session.ts', () => ({
  useSession: vi.fn(),
}));

import { useSession } from '../hooks/use-session.ts';
import type { UseSessionResult } from '../hooks/use-session.ts';
import { SessionProvider } from '../components/session-provider.tsx';
import { useSessionContext } from '../context/session-context.ts';

const mockUseSession = useSession as ReturnType<typeof vi.fn>;

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeSessionResult(overrides: Partial<UseSessionResult> = {}): UseSessionResult {
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

function SessionConsumer() {
  const ctx = useSessionContext();
  return (
    <div>
      <span data-testid="operator-id">{ctx.session?.operatorId ?? 'none'}</span>
      <span data-testid="loading-state">{ctx.isLoading ? 'loading' : 'ready'}</span>
    </div>
  );
}

function ExtendConsumer() {
  const ctx = useSessionContext();
  return (
    <button data-testid="extend-btn" onClick={() => void ctx.extend()}>
      Extend
    </button>
  );
}

function LogoutConsumer() {
  const ctx = useSessionContext();
  return (
    <button data-testid="logout-btn" onClick={() => void ctx.logout()}>
      Logout
    </button>
  );
}

function BareConsumer() {
  useSessionContext();
  return <div>Should not render</div>;
}

class TestErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  override state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override render() {
    if (this.state.error) {
      return <div data-testid="error-message">{this.state.error.message}</div>;
    }
    return this.props.children;
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  mockUseSession.mockReturnValue(makeSessionResult());
});

describe('SessionProvider', () => {
  it('useSessionContext() throws with descriptive message outside provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <TestErrorBoundary>
        <BareConsumer />
      </TestErrorBoundary>,
    );

    expect(screen.getByTestId('error-message')).toHaveTextContent(
      'useSessionContext() must be called inside a <SessionProvider>.',
    );

    spy.mockRestore();
  });

  it('useSessionContext() returns session value inside provider', () => {
    const now = new Date().toISOString();
    mockUseSession.mockReturnValue(
      makeSessionResult({
        session: {
          operatorId: 'op-99',
          state: 'active',
          expiresAt: now,
          lastActivityAt: now,
          createdAt: now,
        },
      }),
    );

    render(
      <SessionProvider>
        <SessionConsumer />
      </SessionProvider>,
    );

    expect(screen.getByTestId('operator-id')).toHaveTextContent('op-99');
  });

  it('useSessionContext() returns isLoading=true during initial fetch', () => {
    mockUseSession.mockReturnValue(makeSessionResult({ isLoading: true, session: null }));

    render(
      <SessionProvider>
        <SessionConsumer />
      </SessionProvider>,
    );

    expect(screen.getByTestId('loading-state')).toHaveTextContent('loading');
  });

  it('extend() callable from consumer', async () => {
    const extend = vi.fn();
    mockUseSession.mockReturnValue(makeSessionResult({ extend }));
    const user = userEvent.setup();

    render(
      <SessionProvider>
        <ExtendConsumer />
      </SessionProvider>,
    );

    await user.click(screen.getByTestId('extend-btn'));
    expect(extend).toHaveBeenCalledOnce();
  });

  it('logout() callable from consumer', async () => {
    const logout = vi.fn();
    mockUseSession.mockReturnValue(makeSessionResult({ logout }));
    const user = userEvent.setup();

    render(
      <SessionProvider>
        <LogoutConsumer />
      </SessionProvider>,
    );

    await user.click(screen.getByTestId('logout-btn'));
    expect(logout).toHaveBeenCalledOnce();
  });

  it('pollInterval prop is forwarded to useSession', () => {
    render(
      <SessionProvider pollInterval={5000}>
        <SessionConsumer />
      </SessionProvider>,
    );

    expect(mockUseSession).toHaveBeenCalledWith(5000);
  });
});

// ── T012 / FD-1: redirect on session expiry ───────────────────────────────

describe('SessionProvider redirect on expiry (T012)', () => {
  it('redirects to /login when session state becomes expired', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onRedirect = vi.fn();

    const now = new Date().toISOString();
    mockUseSession.mockReturnValue(
      makeSessionResult({
        session: {
          operatorId: 'op-1',
          state: 'expired',
          expiresAt: now,
          lastActivityAt: now,
          createdAt: now,
        },
      }),
    );

    render(
      <SessionProvider onRedirect={onRedirect}>
        <SessionConsumer />
      </SessionProvider>,
    );

    vi.advanceTimersByTime(600);

    expect(onRedirect).toHaveBeenCalledWith('/login');

    vi.useRealTimers();
  });

  it('redirects to /login when session state becomes invalidated', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onRedirect = vi.fn();

    const now = new Date().toISOString();
    mockUseSession.mockReturnValue(
      makeSessionResult({
        session: {
          operatorId: 'op-1',
          state: 'invalidated',
          expiresAt: now,
          lastActivityAt: now,
          createdAt: now,
        },
      }),
    );

    render(
      <SessionProvider onRedirect={onRedirect}>
        <SessionConsumer />
      </SessionProvider>,
    );

    vi.advanceTimersByTime(600);

    expect(onRedirect).toHaveBeenCalledWith('/login');

    vi.useRealTimers();
  });

  it('does not redirect for active or expiring-soon states', () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onRedirect = vi.fn();

    const now = new Date().toISOString();
    for (const state of ['active', 'expiring-soon'] as const) {
      mockUseSession.mockReturnValue(
        makeSessionResult({
          session: {
            operatorId: 'op-1',
            state,
            expiresAt: now,
            lastActivityAt: now,
            createdAt: now,
          },
        }),
      );

      const { unmount } = render(
        <SessionProvider onRedirect={onRedirect}>
          <SessionConsumer />
        </SessionProvider>,
      );

      vi.advanceTimersByTime(2000);
      expect(onRedirect).not.toHaveBeenCalled();
      unmount();
    }

    vi.useRealTimers();
  });

  it('uses custom loginPath when provided', () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onRedirect = vi.fn();

    const now = new Date().toISOString();
    mockUseSession.mockReturnValue(
      makeSessionResult({
        session: {
          operatorId: 'op-1',
          state: 'expired',
          expiresAt: now,
          lastActivityAt: now,
          createdAt: now,
        },
      }),
    );

    render(
      <SessionProvider loginPath="/auth/sign-in" onRedirect={onRedirect}>
        <SessionConsumer />
      </SessionProvider>,
    );

    vi.advanceTimersByTime(600);

    expect(onRedirect).toHaveBeenCalledWith('/auth/sign-in');

    vi.useRealTimers();
  });

  it('redirects to /login when a previously-authenticated session collapses to null', () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onRedirect = vi.fn();

    const now = new Date().toISOString();
    mockUseSession
      .mockReturnValueOnce(
        makeSessionResult({
          session: {
            operatorId: 'op-1',
            state: 'active',
            expiresAt: now,
            lastActivityAt: now,
            createdAt: now,
          },
        }),
      )
      .mockReturnValueOnce(makeSessionResult({ session: null, isLoading: false }));

    const { rerender } = render(
      <SessionProvider onRedirect={onRedirect}>
        <SessionConsumer />
      </SessionProvider>,
    );

    rerender(
      <SessionProvider onRedirect={onRedirect}>
        <SessionConsumer />
      </SessionProvider>,
    );

    vi.advanceTimersByTime(600);

    expect(onRedirect).toHaveBeenCalledWith('/login');

    vi.useRealTimers();
  });

  it('still redirects under React StrictMode replay for expired sessions', () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onRedirect = vi.fn();

    const now = new Date().toISOString();
    mockUseSession.mockReturnValue(
      makeSessionResult({
        session: {
          operatorId: 'op-1',
          state: 'expired',
          expiresAt: now,
          lastActivityAt: now,
          createdAt: now,
        },
      }),
    );

    render(
      <React.StrictMode>
        <SessionProvider onRedirect={onRedirect}>
          <SessionConsumer />
        </SessionProvider>
      </React.StrictMode>,
    );

    vi.advanceTimersByTime(600);

    expect(onRedirect).toHaveBeenCalledTimes(1);
    expect(onRedirect).toHaveBeenCalledWith('/login');

    vi.useRealTimers();
  });
});
