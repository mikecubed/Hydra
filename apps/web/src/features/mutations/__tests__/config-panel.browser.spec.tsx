/**
 * T027 — Config panel browser specs.
 *
 * Covers:
 * - ConfigPanel: renders routing section from mocked SafeConfigView, no forbidden
 *   key substrings, 503 daemon-unreachable message, stub sections present
 * - ConfirmDialog: cancel does not call onConfirm, confirm calls once,
 *   disabled when isLoading, from/to values visible
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react';

import type { MutationsClient } from '../api/mutations-client.ts';
import { MutationsRequestError } from '../api/mutations-client.ts';
import { ConfigPanel } from '../components/config-panel.tsx';
import { ConfirmDialog } from '../components/confirm-dialog.tsx';

afterEach(() => {
  cleanup();
});

// ─── Mock client factory ─────────────────────────────────────────────────────

function makeMockClient(
  overrides: Partial<MutationsClient> = {},
): MutationsClient {
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

// ─── ConfigPanel specs ───────────────────────────────────────────────────────

describe('ConfigPanel', () => {
  it('renders routing section from mocked SafeConfigView (no crash)', async () => {
    const client = makeMockClient();
    await act(async () => {
      render(<ConfigPanel client={client} />);
    });
    expect(screen.getAllByText(/economy/i).length).toBeGreaterThan(0);
  });

  it('rendered output contains no forbidden key substrings (SC-010)', async () => {
    const client = makeMockClient();
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<ConfigPanel client={client} />));
    });
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/key/i);
    expect(text).not.toMatch(/secret/i);
    expect(text).not.toMatch(/hash/i);
    expect(text).not.toMatch(/password/i);
  });

  it('shows daemon-unreachable message when getSafeConfig returns 503', async () => {
    const client = makeMockClient({
      getSafeConfig: vi.fn().mockRejectedValue(
        new MutationsRequestError(503, {
          ok: false,
          code: 'DAEMON_UNREACHABLE',
          category: 'daemon',
          message: 'Daemon unreachable',
          httpStatus: 503,
        }),
      ),
    });
    await act(async () => {
      render(<ConfigPanel client={client} />);
    });
    expect(screen.getByText(/daemon unreachable/i)).toBeDefined();
  });

  it('renders stub sections without crashing', async () => {
    const client = makeMockClient();
    await act(async () => {
      render(<ConfigPanel client={client} />);
    });
    expect(screen.getByLabelText(/models configuration/i)).toBeDefined();
    expect(screen.getByLabelText(/budgets configuration/i)).toBeDefined();
  });
});

// ─── ConfirmDialog specs ─────────────────────────────────────────────────────

describe('ConfirmDialog', () => {
  it('cancel button does NOT call onConfirm', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        isOpen={true}
        title="Change Mode"
        from="economy"
        to="balanced"
        onConfirm={onConfirm}
        onCancel={onCancel}
        isLoading={false}
      />,
    );
    fireEvent.click(screen.getByText('Cancel'));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('confirm button calls onConfirm exactly once', () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        isOpen={true}
        title="Change Mode"
        from="economy"
        to="balanced"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
        isLoading={false}
      />,
    );
    fireEvent.click(screen.getByText('Confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('confirm button is disabled when isLoading=true', () => {
    render(
      <ConfirmDialog
        isOpen={true}
        title="Change Mode"
        from="economy"
        to="balanced"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        isLoading={true}
      />,
    );
    const confirmBtn = screen.getByText('Applying…');
    expect(confirmBtn).toHaveAttribute('disabled');
  });

  it('from and to prop values are visible in the rendered dialog', () => {
    render(
      <ConfirmDialog
        isOpen={true}
        title="Change Mode"
        from="economy"
        to="performance"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        isLoading={false}
      />,
    );
    expect(screen.getByText('economy')).toBeDefined();
    expect(screen.getByText('performance')).toBeDefined();
  });

  it('renders nothing when isOpen=false', () => {
    const { container } = render(
      <ConfirmDialog
        isOpen={false}
        title="Change Mode"
        from="economy"
        to="balanced"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        isLoading={false}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
