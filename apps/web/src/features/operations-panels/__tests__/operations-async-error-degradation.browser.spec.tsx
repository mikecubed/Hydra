/**
 * FD-5 — Async-error → degraded-panel path in operations panels (T016).
 *
 * Covers the integration scenario where one operations sub-panel experiences
 * an async fetch failure: the degraded banner appears, sibling panels remain
 * healthy, and the retry button initiates recovery. Also tests the error
 * boundary + degraded banner coexistence and sequential failure/recovery.
 */

import type { JSX } from 'react';
import type {
  GetOperationsSnapshotResponse,
  GetWorkItemCheckpointsResponse,
  GetWorkItemControlsResponse,
  GetWorkItemDetailResponse,
  GetWorkItemExecutionResponse,
  OperationalControlView,
  SubmitControlActionResponse,
  WorkQueueItemView,
} from '@hydra/web-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';

const { createOperationsClientMock } = vi.hoisted(() => ({
  createOperationsClientMock: vi.fn(),
}));

vi.mock('../api/operations-client.ts', () => ({
  createOperationsClient: createOperationsClientMock,
}));

import type { OperationsClient } from '../api/operations-client.ts';
import { OperationsDegradedBanner } from '../components/operations-degraded-banner.tsx';
import { OperationsErrorBoundary } from '../components/operations-error-boundary.tsx';
import { WorkspaceOperationsPanel } from '../components/workspace-operations-panel.tsx';

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  createOperationsClientMock.mockReset();
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function HealthyPanel({ label }: { readonly label: string }): JSX.Element {
  return <div data-testid={`panel-${label}`}>Panel {label} OK</div>;
}

function ThrowingPanel({ message }: { readonly message: string }): never {
  throw new Error(message);
}

function suppressConsoleError(): () => void {
  const original = console.error;
  console.error = () => {};
  return () => {
    console.error = original;
  };
}

function makeQueueItem(overrides: Partial<WorkQueueItemView> = {}): WorkQueueItemView {
  return {
    id: 'wi-42',
    title: 'Inspect recovery candidate',
    status: 'active',
    position: 0,
    relatedConversationId: null,
    relatedSessionId: null,
    ownerLabel: 'codex',
    lastCheckpointSummary: null,
    updatedAt: '2026-07-01T00:00:00.000Z',
    riskSignals: [],
    detailAvailability: 'ready',
    ...overrides,
  };
}

function makeSnapshot(
  overrides: Partial<GetOperationsSnapshotResponse> = {},
): GetOperationsSnapshotResponse {
  return {
    queue: [makeQueueItem()],
    health: null,
    budget: null,
    availability: 'ready',
    lastSynchronizedAt: '2026-07-01T00:00:00.000Z',
    nextCursor: null,
    ...overrides,
  };
}

function makeDetail(overrides: Partial<GetWorkItemDetailResponse> = {}): GetWorkItemDetailResponse {
  const item = overrides.item ?? makeQueueItem();
  return {
    item,
    checkpoints: [],
    routing: {
      currentRoute: 'codex',
      currentMode: 'balanced',
      changedAt: '2026-07-01T00:01:00.000Z',
      history: [],
    },
    assignments: [],
    council: null,
    controls: [],
    itemBudget: null,
    availability: 'ready',
    ...overrides,
  };
}

function makeControl(overrides: Partial<OperationalControlView> = {}): OperationalControlView {
  return {
    controlId: 'ctrl-1',
    kind: 'routing',
    label: 'Route override',
    availability: 'actionable',
    authority: 'granted',
    reason: null,
    options: [],
    expectedRevision: 'rev-1',
    lastResolvedAt: null,
    ...overrides,
  };
}

function makeCheckpointsResponse(
  overrides: Partial<GetWorkItemCheckpointsResponse> = {},
): GetWorkItemCheckpointsResponse {
  return {
    workItemId: 'wi-42',
    checkpoints: [],
    availability: 'ready',
    ...overrides,
  };
}

function makeExecutionResponse(
  overrides: Partial<GetWorkItemExecutionResponse> = {},
): GetWorkItemExecutionResponse {
  return {
    workItemId: 'wi-42',
    routing: null,
    assignments: [],
    council: null,
    availability: 'ready',
    ...overrides,
  };
}

function makeControlsResponse(
  overrides: Partial<GetWorkItemControlsResponse> = {},
): GetWorkItemControlsResponse {
  return {
    workItemId: 'wi-42',
    controls: [],
    availability: 'ready',
    ...overrides,
  };
}

function makeSubmitResponse(
  overrides: Partial<SubmitControlActionResponse> = {},
): SubmitControlActionResponse {
  return {
    outcome: 'accepted',
    control: makeControl({ availability: 'accepted', expectedRevision: 'rev-2' }),
    workItemId: 'wi-42',
    resolvedAt: '2026-07-01T00:02:00.000Z',
    ...overrides,
  };
}

function makeOperationsClient(overrides: Partial<OperationsClient> = {}): OperationsClient {
  return {
    getSnapshot: vi.fn(async () => makeSnapshot()),
    getWorkItemDetail: vi.fn(async () => makeDetail()),
    getWorkItemCheckpoints: vi.fn(async () => makeCheckpointsResponse()),
    getWorkItemExecution: vi.fn(async () => makeExecutionResponse()),
    getWorkItemControls: vi.fn(async () => makeControlsResponse()),
    submitControlAction: vi.fn(async () => makeSubmitResponse()),
    discoverControls: vi.fn(async () => ({ items: [] })),
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('FD-5: async error → degraded panel path', () => {
  it('degraded banner appears while sibling panels remain healthy', () => {
    render(
      <div>
        <OperationsDegradedBanner message="Snapshot fetch failed for queue panel" />
        <HealthyPanel label="execution" />
        <HealthyPanel label="checkpoint" />
      </div>,
    );

    // Degraded banner is visible
    expect(screen.getByTestId('operations-degraded-banner')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Snapshot fetch failed for queue panel');

    // Sibling panels are unaffected
    expect(screen.getByTestId('panel-execution')).toHaveTextContent('Panel execution OK');
    expect(screen.getByTestId('panel-checkpoint')).toHaveTextContent('Panel checkpoint OK');
  });

  it('retry button in degraded banner triggers recovery callback', () => {
    const onRetry = vi.fn();

    render(
      <div>
        <OperationsDegradedBanner message="Detail fetch failed" onRetry={onRetry} />
        <HealthyPanel label="queue" />
      </div>,
    );

    expect(screen.getByTestId('operations-retry-button')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('operations-retry-button'));
    expect(onRetry).toHaveBeenCalledOnce();

    // Sibling still healthy after retry
    expect(screen.getByTestId('panel-queue')).toHaveTextContent('Panel queue OK');
  });

  it('real panel snapshot failure shows degraded banner and retry reloads the queue', async () => {
    const getSnapshot = vi
      .fn<OperationsClient['getSnapshot']>()
      .mockRejectedValueOnce(new Error('Snapshot fetch failed for queue panel'))
      .mockResolvedValueOnce(makeSnapshot());
    createOperationsClientMock.mockReturnValue(makeOperationsClient({ getSnapshot }));

    render(<WorkspaceOperationsPanel />);

    expect(await screen.findByTestId('operations-degraded-banner')).toHaveTextContent(
      'Snapshot fetch failed for queue panel',
    );
    expect(screen.getByTestId('operations-retry-button')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('operations-retry-button'));

    expect(await screen.findByText('Inspect recovery candidate')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByTestId('operations-degraded-banner')).not.toBeInTheDocument();
    });
    expect(getSnapshot).toHaveBeenCalledTimes(2);
  });

  it('real panel detail failure is surfaced by panel state and recovers on reselect retry', async () => {
    const getWorkItemDetail = vi
      .fn<OperationsClient['getWorkItemDetail']>()
      .mockRejectedValueOnce(new Error('detail fetch failed'))
      .mockResolvedValueOnce(makeDetail());
    createOperationsClientMock.mockReturnValue(makeOperationsClient({ getWorkItemDetail }));

    render(<WorkspaceOperationsPanel />);

    const queueItem = await screen.findByRole('button', { name: /inspect recovery candidate/i });
    fireEvent.click(queueItem);

    expect(await screen.findByText('Failed to load routing data.')).toBeInTheDocument();
    expect(screen.getByText('Failed to load execution data.')).toBeInTheDocument();
    expect(screen.getByText('Failed to load checkpoint data.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /inspect recovery candidate/i }));

    expect(await screen.findByTestId('routing-current-route')).toHaveTextContent('codex');
    await waitFor(() => {
      expect(screen.queryByText('Failed to load routing data.')).not.toBeInTheDocument();
    });
    expect(getWorkItemDetail).toHaveBeenCalledTimes(2);
  });

  it('error boundary catches sync render crash while sibling degraded banner is separate', () => {
    const restore = suppressConsoleError();

    render(
      <div>
        <OperationsErrorBoundary>
          <ThrowingPanel message="Execution panel crash" />
        </OperationsErrorBoundary>
        <OperationsDegradedBanner message="Queue snapshot stale" />
        <HealthyPanel label="routing" />
      </div>,
    );

    restore();

    // Error boundary caught the crash
    expect(screen.getByTestId('operations-panel-error-boundary')).toBeInTheDocument();
    expect(screen.getByTestId('operations-panel-error-boundary')).toHaveTextContent(
      'Execution panel crash',
    );

    // Degraded banner independently visible for async failure
    expect(screen.getByTestId('operations-degraded-banner')).toHaveTextContent(
      'Queue snapshot stale',
    );

    // Routing panel remains healthy
    expect(screen.getByTestId('panel-routing')).toHaveTextContent('Panel routing OK');
  });

  it('error boundary "Try again" resets while degraded banner persists independently', () => {
    const restore = suppressConsoleError();

    render(
      <div>
        <OperationsErrorBoundary>
          <ThrowingPanel message="Panel crash" />
        </OperationsErrorBoundary>
        <OperationsDegradedBanner message="Async error remains" />
      </div>,
    );

    restore();

    // Both error surfaces present
    expect(screen.getByTestId('operations-panel-error-boundary')).toBeInTheDocument();
    expect(screen.getByTestId('operations-degraded-banner')).toBeInTheDocument();

    // Click "Try again" on error boundary — child still throws so boundary re-catches
    const restoreAgain = suppressConsoleError();
    fireEvent.click(screen.getByTestId('operations-error-retry'));
    restoreAgain();

    // Error boundary still in fallback (child still throws)
    expect(screen.getByTestId('operations-panel-error-boundary')).toBeInTheDocument();

    // Degraded banner is independent and unaffected
    expect(screen.getByTestId('operations-degraded-banner')).toHaveTextContent(
      'Async error remains',
    );
  });

  it('multiple degraded banners can coexist for different sub-panels', () => {
    render(
      <div>
        <OperationsDegradedBanner message="Queue panel: snapshot timeout" />
        <OperationsDegradedBanner message="Health panel: budget fetch failed" />
        <HealthyPanel label="execution" />
      </div>,
    );

    const banners = screen.getAllByTestId('operations-degraded-banner');
    expect(banners).toHaveLength(2);
    expect(banners[0]).toHaveTextContent('Queue panel: snapshot timeout');
    expect(banners[1]).toHaveTextContent('Health panel: budget fetch failed');

    // Healthy sibling unaffected
    expect(screen.getByTestId('panel-execution')).toBeInTheDocument();
  });

  it('degraded banner with no onRetry omits retry button gracefully', () => {
    render(
      <div>
        <OperationsDegradedBanner message="Transient error — will auto-recover" />
        <HealthyPanel label="queue" />
      </div>,
    );

    expect(screen.getByTestId('operations-degraded-banner')).toBeInTheDocument();
    expect(screen.queryByTestId('operations-retry-button')).not.toBeInTheDocument();
    expect(screen.getByTestId('panel-queue')).toBeInTheDocument();
  });

  it('degraded banner aria attributes support screen reader announcement', () => {
    render(<OperationsDegradedBanner message="Panel degraded" />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('aria-live', 'polite');
    expect(alert).toHaveTextContent('Panel degraded');
  });
});
