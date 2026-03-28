/**
 * T033 — WorkflowLaunchPanel browser specs.
 *
 * Covers:
 * - evolve → DestructiveConfirmDialog (step 2 phrase input visible)
 * - tasks → standard ConfirmDialog (no phrase input)
 * - Cancel: postWorkflowLaunch mock never called
 * - tasks confirm with mocked success: task ID shown in panel
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react';

import type { MutationsClient } from '../api/mutations-client.ts';
import { WorkflowLaunchPanel } from '../components/workflow-launch-panel.tsx';

afterEach(() => {
  cleanup();
});

function makeMockClient(overrides: Partial<MutationsClient> = {}): MutationsClient {
  return {
    getSafeConfig: vi.fn(),
    postRoutingMode: vi.fn(),
    postModelTier: vi.fn(),
    postBudget: vi.fn(),
    postWorkflowLaunch: vi.fn().mockResolvedValue({
      taskId: 'task-abc-123',
      workflow: 'tasks',
      launchedAt: '2026-03-28T05:00:00.000Z',
      destructive: false,
    }),
    getAudit: vi.fn(),
    ...overrides,
  };
}

describe('WorkflowLaunchPanel', () => {
  it('selecting evolve and clicking Launch opens DestructiveConfirmDialog (phrase input visible)', () => {
    const client = makeMockClient();
    render(<WorkflowLaunchPanel revision="rev-1" client={client} />);
    fireEvent.click(screen.getByDisplayValue('evolve'));
    fireEvent.click(screen.getByText('Launch'));
    // Step 1 of destructive dialog: standard confirm button visible
    expect(screen.getByText('Confirm')).toBeDefined();
    // Advance to step 2
    fireEvent.click(screen.getByText('Confirm'));
    // Phrase input should now be visible
    expect(screen.getByLabelText('Confirmation phrase')).toBeDefined();
  });

  it('selecting tasks and clicking Launch opens standard ConfirmDialog (no phrase input)', () => {
    const client = makeMockClient();
    render(<WorkflowLaunchPanel revision="rev-1" client={client} />);
    // tasks is default selection
    fireEvent.click(screen.getByText('Launch'));
    expect(screen.getByText('Confirm')).toBeDefined();
    expect(screen.queryByLabelText('Confirmation phrase')).toBeNull();
  });

  it('dismissing tasks dialog (Cancel): postWorkflowLaunch is never called', () => {
    const postWorkflowLaunch = vi.fn();
    const client = makeMockClient({ postWorkflowLaunch });
    render(<WorkflowLaunchPanel revision="rev-1" client={client} />);
    fireEvent.click(screen.getByText('Launch'));
    fireEvent.click(screen.getByText('Cancel'));
    expect(postWorkflowLaunch).not.toHaveBeenCalled();
  });

  it('dismissing evolve dialog (Cancel at step 1): postWorkflowLaunch never called', () => {
    const postWorkflowLaunch = vi.fn();
    const client = makeMockClient({ postWorkflowLaunch });
    render(<WorkflowLaunchPanel revision="rev-1" client={client} />);
    fireEvent.click(screen.getByDisplayValue('evolve'));
    fireEvent.click(screen.getByText('Launch'));
    fireEvent.click(screen.getByText('Cancel'));
    expect(postWorkflowLaunch).not.toHaveBeenCalled();
  });

  it('confirming tasks launch with mocked success: task ID shown in panel', async () => {
    const client = makeMockClient();
    render(<WorkflowLaunchPanel revision="rev-1" client={client} />);
    fireEvent.click(screen.getByText('Launch'));
    await act(async () => {
      fireEvent.click(screen.getByText('Confirm'));
    });
    expect(screen.getByText(/task-abc-123/i)).toBeDefined();
  });
});
