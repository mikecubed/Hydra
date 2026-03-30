/**
 * FD-1 — Delayed-detection session expiry edge case (T016).
 *
 * Covers the path where a session expires silently (no WebSocket push),
 * the polling loop eventually detects the terminal state, and the
 * SessionProvider redirects the operator to /login. Also verifies
 * that the ExpiryBanner disappears once the state becomes terminal
 * and that intermediate poll errors do not prematurely trigger redirect.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { SessionInfo } from '@hydra/web-contracts';

vi.mock('../hooks/use-session.ts', () => ({
  useSession: vi.fn(),
}));

import { useSession } from '../hooks/use-session.ts';
import type { UseSessionResult } from '../hooks/use-session.ts';
import { SessionProvider } from '../components/session-provider.tsx';
import { ExpiryBanner } from '../components/expiry-banner.tsx';
import { useSessionContext } from '../context/session-context.ts';

const mockUseSession = useSession as ReturnType<typeof vi.fn>;

// ── Helpers ─────────────────────────────────────────────────────────────────

const NOW = new Date().toISOString();

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

function makeSession(state: SessionInfo['state']): SessionInfo {
  return {
    operatorId: 'op-1',
    state,
    expiresAt: NOW,
    lastActivityAt: NOW,
    createdAt: NOW,
  };
}

/** Consumer that surfaces session state for assertions. */
function SessionConsumer() {
  const ctx = useSessionContext();
  return (
    <div>
      <span data-testid="session-state">{ctx.session?.state ?? 'none'}</span>
      <span data-testid="poll-errors">{String(ctx.pollErrorCount)}</span>
    </div>
  );
}

// ── Setup / Teardown ────────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mockUseSession.mockReturnValue(makeSessionResult({ session: makeSession('active') }));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('FD-1: delayed-detection session expiry', () => {
  it('redirects to /login when poll detects silent expiry (active → expired)', () => {
    const onRedirect = vi.fn();

    // Phase 1: active session
    mockUseSession.mockReturnValue(makeSessionResult({ session: makeSession('active') }));

    const { rerender } = render(
      <SessionProvider onRedirect={onRedirect}>
        <SessionConsumer />
      </SessionProvider>,
    );

    expect(screen.getByTestId('session-state')).toHaveTextContent('active');
    expect(onRedirect).not.toHaveBeenCalled();

    // Phase 2: poll returns expired (silent expiry — no WS push)
    mockUseSession.mockReturnValue(makeSessionResult({ session: makeSession('expired') }));

    rerender(
      <SessionProvider onRedirect={onRedirect}>
        <SessionConsumer />
      </SessionProvider>,
    );

    // Redirect fires after REDIRECT_DELAY_MS (500ms)
    vi.advanceTimersByTime(600);
    expect(onRedirect).toHaveBeenCalledWith('/login');
  });

  it('redirects on poll-detected invalidation (active → invalidated)', () => {
    const onRedirect = vi.fn();

    mockUseSession.mockReturnValue(makeSessionResult({ session: makeSession('active') }));

    const { rerender } = render(
      <SessionProvider onRedirect={onRedirect}>
        <SessionConsumer />
      </SessionProvider>,
    );

    // Poll returns invalidated
    mockUseSession.mockReturnValue(makeSessionResult({ session: makeSession('invalidated') }));

    rerender(
      <SessionProvider onRedirect={onRedirect}>
        <SessionConsumer />
      </SessionProvider>,
    );

    vi.advanceTimersByTime(600);
    expect(onRedirect).toHaveBeenCalledWith('/login');
  });

  it('transitions through expiring-soon before redirect on expiry', () => {
    const onRedirect = vi.fn();

    // Phase 1: active
    mockUseSession.mockReturnValue(makeSessionResult({ session: makeSession('active') }));

    const { rerender } = render(
      <SessionProvider onRedirect={onRedirect}>
        <SessionConsumer />
      </SessionProvider>,
    );

    // Phase 2: poll detects expiring-soon (no redirect yet)
    mockUseSession.mockReturnValue(makeSessionResult({ session: makeSession('expiring-soon') }));

    rerender(
      <SessionProvider onRedirect={onRedirect}>
        <SessionConsumer />
      </SessionProvider>,
    );

    vi.advanceTimersByTime(2000);
    expect(onRedirect).not.toHaveBeenCalled();
    expect(screen.getByTestId('session-state')).toHaveTextContent('expiring-soon');

    // Phase 3: poll detects expired
    mockUseSession.mockReturnValue(makeSessionResult({ session: makeSession('expired') }));

    rerender(
      <SessionProvider onRedirect={onRedirect}>
        <SessionConsumer />
      </SessionProvider>,
    );

    vi.advanceTimersByTime(600);
    expect(onRedirect).toHaveBeenCalledWith('/login');
  });

  it('poll errors alone do not trigger redirect while session is still active', () => {
    const onRedirect = vi.fn();

    // Active session with accumulating poll errors
    mockUseSession.mockReturnValue(
      makeSessionResult({ session: makeSession('active'), pollErrorCount: 3 }),
    );

    render(
      <SessionProvider onRedirect={onRedirect}>
        <SessionConsumer />
      </SessionProvider>,
    );

    vi.advanceTimersByTime(5000);
    expect(onRedirect).not.toHaveBeenCalled();
    expect(screen.getByTestId('poll-errors')).toHaveTextContent('3');
  });

  it('redirects when session collapses to null after poll errors during active session', () => {
    const onRedirect = vi.fn();

    // Phase 1: active with some poll errors
    mockUseSession.mockReturnValue(
      makeSessionResult({ session: makeSession('active'), pollErrorCount: 2 }),
    );

    const { rerender } = render(
      <SessionProvider onRedirect={onRedirect}>
        <SessionConsumer />
      </SessionProvider>,
    );

    // Phase 2: poll finally returns null (total collapse)
    mockUseSession.mockReturnValue(
      makeSessionResult({ session: null, isLoading: false, pollErrorCount: 5 }),
    );

    rerender(
      <SessionProvider onRedirect={onRedirect}>
        <SessionConsumer />
      </SessionProvider>,
    );

    vi.advanceTimersByTime(600);
    expect(onRedirect).toHaveBeenCalledWith('/login');
  });

  it('ExpiryBanner is not shown once session state becomes expired (terminal)', () => {
    // expiring-soon → banner visible
    mockUseSession.mockReturnValue(makeSessionResult({ session: makeSession('expiring-soon') }));

    const { rerender } = render(
      <SessionProvider>
        <ExpiryBanner />
      </SessionProvider>,
    );

    expect(screen.getByTestId('expiry-banner')).toBeInTheDocument();

    // expired → banner disappears (component returns null for non-expiring-soon)
    mockUseSession.mockReturnValue(makeSessionResult({ session: makeSession('expired') }));

    rerender(
      <SessionProvider>
        <ExpiryBanner />
      </SessionProvider>,
    );

    expect(screen.queryByTestId('expiry-banner')).not.toBeInTheDocument();
  });
});
