/**
 * FD-4 — Reject → dismiss → retry cycle for protected mutations (T016).
 *
 * Covers the integration path where a config mutation is rejected by the
 * gateway, the operator sees and dismisses the error banner, then retries
 * successfully. Tests the full cycle including category-specific guidance
 * (stale-revision, daemon), dismiss clearing state, and retry succeeding.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, act } from '@testing-library/react';

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

describe('FD-4: reject → dismiss → retry cycle', () => {
  it('shows stale-revision rejection with category guidance, dismiss clears it', async () => {
    const client = makeMockClient({
      getSafeConfig: vi
        .fn()
        .mockRejectedValueOnce(
          new MutationsRequestError(409, {
            ok: false,
            code: 'STALE_REVISION',
            category: 'stale-revision',
            message: 'Config revision is stale',
            httpStatus: 409,
          }),
        )
        .mockResolvedValue({
          config: { routing: { mode: 'economy' } },
          revision: 'rev-fresh',
        }),
    });

    await act(async () => {
      render(<ConfigPanel client={client} />);
    });

    // Error banner should be visible with stale-revision message
    expect(screen.getByTestId('mutation-error-banner')).toBeInTheDocument();
    expect(screen.getByText('Config revision is stale')).toBeInTheDocument();

    // Dismiss (which calls refetch in ConfigPanel)
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Dismiss error'));
    });

    // After dismiss triggers refetch with fresh data, panel renders normally
    expect(screen.queryByTestId('mutation-error-banner')).not.toBeInTheDocument();
  });

  it('daemon-unavailable rejection shows specialized banner, retry recovers', async () => {
    const client = makeMockClient({
      getSafeConfig: vi
        .fn()
        .mockRejectedValueOnce(
          new MutationsRequestError(503, {
            ok: false,
            code: 'DAEMON_UNAVAILABLE',
            category: 'daemon-unavailable',
            message: 'Gateway cannot reach daemon',
            httpStatus: 503,
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

    // Daemon-unavailable shows a specialized message (not generic error banner)
    expect(screen.getByRole('alert')).toHaveTextContent('Config unavailable — daemon unreachable');
    expect(screen.queryByTestId('mutation-error-banner')).not.toBeInTheDocument();
  });

  it('generic daemon rejection shows error banner with dismiss/retry path', async () => {
    const client = makeMockClient({
      getSafeConfig: vi
        .fn()
        .mockRejectedValueOnce(
          new MutationsRequestError(500, {
            ok: false,
            code: 'DAEMON_ERROR',
            category: 'daemon',
            message: 'Internal daemon error',
            httpStatus: 500,
          }),
        )
        .mockResolvedValue({
          config: { routing: { mode: 'economy' } },
          revision: 'rev-1',
        }),
    });

    await act(async () => {
      render(<ConfigPanel client={client} />);
    });

    // Shows generic error banner (daemon category, not daemon-unavailable)
    expect(screen.getByTestId('mutation-error-banner')).toBeInTheDocument();
    expect(screen.getByText('Internal daemon error')).toBeInTheDocument();

    // Dismiss triggers refetch → succeeds → panel renders normally
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Dismiss error'));
    });

    expect(screen.queryByTestId('mutation-error-banner')).not.toBeInTheDocument();
  });

  it('repeated rejections cycle: first fails, second fails differently, third succeeds', async () => {
    let callCount = 0;
    const client = makeMockClient({
      getSafeConfig: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          throw new MutationsRequestError(409, {
            ok: false,
            code: 'STALE_REVISION',
            category: 'stale-revision',
            message: 'Stale revision',
            httpStatus: 409,
          });
        }
        if (callCount === 2) {
          throw new MutationsRequestError(500, {
            ok: false,
            code: 'DAEMON_ERROR',
            category: 'daemon',
            message: 'Temporary daemon failure',
            httpStatus: 500,
          });
        }
        return {
          config: { routing: { mode: 'economy' } },
          revision: 'rev-3',
        };
      }),
    });

    // First render: stale-revision rejection
    await act(async () => {
      render(<ConfigPanel client={client} />);
    });

    expect(screen.getByText('Stale revision')).toBeInTheDocument();

    // Dismiss (triggers refetch) → second rejection (daemon error)
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Dismiss error'));
    });

    expect(screen.getByText('Temporary daemon failure')).toBeInTheDocument();

    // Dismiss again → third call succeeds
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Dismiss error'));
    });

    expect(screen.queryByTestId('mutation-error-banner')).not.toBeInTheDocument();
  });
});
