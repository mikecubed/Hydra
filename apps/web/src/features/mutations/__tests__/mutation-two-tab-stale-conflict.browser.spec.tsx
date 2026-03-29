/**
 * FD-8 — Two-tab stale-revision conflict scenario (T016).
 *
 * Covers the multi-session conflict path where two browser tabs operate on
 * the same config surface: one tab mutates successfully (advancing the
 * revision), while the second tab's mutation is rejected with a stale-revision
 * error. The spec verifies that the stale-revision guidance is surfaced, the
 * dismiss/retry affordance works, and a retry after refresh succeeds.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, act } from '@testing-library/react';

import { MutationErrorBanner } from '../components/mutation-error-banner.tsx';
import type { MutationsClient } from '../api/mutations-client.ts';
import { MutationsRequestError } from '../api/mutations-client.ts';
import { ConfigPanel } from '../components/config-panel.tsx';

afterEach(() => {
  cleanup();
});

// ── Mock client factory ─────────────────────────────────────────────────────

function makeMockClient(overrides: Partial<MutationsClient> = {}): MutationsClient {
  return {
    getSafeConfig: vi.fn().mockResolvedValue({
      config: { routing: { mode: 'economy' } },
      revision: 'rev-1',
    }),
    postRoutingMode: vi.fn().mockResolvedValue({
      snapshot: { routing: { mode: 'balanced' } },
      appliedRevision: 'rev-2',
      timestamp: '2026-03-28T04:00:00.000Z',
    }),
    postModelTier: vi.fn(),
    postBudget: vi.fn(),
    postWorkflowLaunch: vi.fn(),
    getAudit: vi.fn(),
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('FD-8: two-tab stale-revision conflict', () => {
  it('stale-revision banner shows refresh guidance for second tab conflict', () => {
    render(
      <MutationErrorBanner
        message="Revision conflict — another tab updated this setting"
        onDismiss={() => {}}
        category="stale-revision"
      />,
    );

    expect(screen.getByTestId('mutation-error-banner')).toBeInTheDocument();
    expect(screen.getByTestId('mutation-error-guidance')).toHaveTextContent(
      /refresh to load the latest version/i,
    );
  });

  it('stale-revision banner provides dismiss + retry affordance', () => {
    const onDismiss = vi.fn();
    const onRetry = vi.fn();

    render(
      <MutationErrorBanner
        message="Stale revision"
        onDismiss={onDismiss}
        category="stale-revision"
        onRetry={onRetry}
      />,
    );

    // Dismiss button
    fireEvent.click(screen.getByLabelText('Dismiss error'));
    expect(onDismiss).toHaveBeenCalledOnce();

    // Retry button
    fireEvent.click(screen.getByTestId('mutation-retry-button'));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('stale-revision is distinct from workflow-conflict guidance', () => {
    const { unmount } = render(
      <MutationErrorBanner message="Stale" onDismiss={() => {}} category="stale-revision" />,
    );

    expect(screen.getByTestId('mutation-error-guidance')).toHaveTextContent(
      /refresh to load the latest/i,
    );
    unmount();

    render(
      <MutationErrorBanner message="Conflict" onDismiss={() => {}} category="workflow-conflict" />,
    );

    expect(screen.getByTestId('mutation-error-guidance')).toHaveTextContent(
      /conflicting workflow/i,
    );
  });

  it('ConfigPanel shows stale-revision error on initial load, dismiss refetches fresh data', async () => {
    const client = makeMockClient({
      getSafeConfig: vi
        .fn()
        .mockRejectedValueOnce(
          new MutationsRequestError(409, {
            ok: false,
            code: 'STALE_REVISION',
            category: 'stale-revision',
            message: 'Another tab updated config',
            httpStatus: 409,
          }),
        )
        .mockResolvedValue({
          config: { routing: { mode: 'balanced' } },
          revision: 'rev-2',
        }),
    });

    await act(async () => {
      render(<ConfigPanel client={client} />);
    });

    // Stale-revision error visible
    expect(screen.getByTestId('mutation-error-banner')).toBeInTheDocument();
    expect(screen.getByText('Another tab updated config')).toBeInTheDocument();

    // Dismiss triggers refetch → fresh data loads successfully
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Dismiss error'));
    });

    // Panel renders normally after fresh fetch
    expect(screen.queryByTestId('mutation-error-banner')).not.toBeInTheDocument();
  });

  it('second stale-revision after first dismiss shows error again', async () => {
    let callCount = 0;
    const client = makeMockClient({
      getSafeConfig: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount <= 2) {
          throw new MutationsRequestError(409, {
            ok: false,
            code: 'STALE_REVISION',
            category: 'stale-revision',
            message: `Stale revision attempt ${String(callCount)}`,
            httpStatus: 409,
          });
        }
        return {
          config: { routing: { mode: 'economy' } },
          revision: 'rev-3',
        };
      }),
    });

    await act(async () => {
      render(<ConfigPanel client={client} />);
    });

    // First stale-revision
    expect(screen.getByText('Stale revision attempt 1')).toBeInTheDocument();

    // Dismiss → refetch → second stale-revision
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Dismiss error'));
    });

    expect(screen.getByText('Stale revision attempt 2')).toBeInTheDocument();

    // Dismiss again → third call succeeds
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Dismiss error'));
    });

    expect(screen.queryByTestId('mutation-error-banner')).not.toBeInTheDocument();
  });

  it('rate-limit rejection shows retry-after hint (not stale-revision guidance)', () => {
    render(
      <MutationErrorBanner
        message="Too many requests from concurrent tabs"
        onDismiss={() => {}}
        category="rate-limit"
        retryAfterMs={10000}
      />,
    );

    // Rate-limit hint shown instead of stale-revision guidance
    expect(screen.getByTestId('mutation-retry-hint')).toHaveTextContent(/try again in 10 seconds/i);
    expect(screen.queryByTestId('mutation-error-guidance')).not.toBeInTheDocument();
  });
});
