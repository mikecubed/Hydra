/**
 * T013 — Queue panel browser specs.
 *
 * Covers:
 * - EmptyStateCard: loading, error, idle, empty queue, unavailable messages
 * - QueueItemCard: title, status badge, owner, risk signals, pending control,
 *   conversation hint, selected state, click handler
 * - QueuePanel: renders items, shows empty state, highlights selection
 * - OperationsPanelShell: heading, freshness badge, loading indicator, children
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { WorkQueueItemView } from '@hydra/web-contracts';

import { EmptyStateCard } from '../components/empty-state-card.tsx';
import { QueueItemCard } from '../components/queue-item-card.tsx';
import { QueuePanel } from '../components/queue-panel.tsx';
import { OperationsPanelShell } from '../components/operations-panel-shell.tsx';

afterEach(() => {
  cleanup();
});

// ─── Fixtures ───────────────────────────────────────────────────────────────

function makeItem(overrides: Partial<WorkQueueItemView> = {}): WorkQueueItemView {
  return {
    id: 'wi-1',
    title: 'Refactor auth module',
    status: 'active',
    position: 0,
    relatedConversationId: null,
    relatedSessionId: null,
    ownerLabel: null,
    lastCheckpointSummary: null,
    updatedAt: '2026-06-01T12:00:00.000Z',
    riskSignals: [],
    detailAvailability: 'ready',
    ...overrides,
  };
}

// ─── EmptyStateCard ─────────────────────────────────────────────────────────

describe('EmptyStateCard', () => {
  it('shows loading message when snapshot is loading', () => {
    render(<EmptyStateCard snapshotStatus="loading" availability="empty" />);
    expect(screen.getByTestId('operations-empty-state')).toHaveTextContent(/loading/i);
  });

  it('shows error message when snapshot failed', () => {
    render(<EmptyStateCard snapshotStatus="error" availability="empty" />);
    expect(screen.getByTestId('operations-empty-state')).toHaveTextContent(/unable to load/i);
  });

  it('shows idle message when snapshot has not been requested', () => {
    render(<EmptyStateCard snapshotStatus="idle" availability="empty" />);
    expect(screen.getByTestId('operations-empty-state')).toHaveTextContent(/not been requested/i);
  });

  it('shows empty queue message when ready with no items', () => {
    render(<EmptyStateCard snapshotStatus="ready" availability="empty" />);
    expect(screen.getByTestId('operations-empty-state')).toHaveTextContent(/no work items/i);
  });

  it('shows unavailable message when data is unavailable', () => {
    render(<EmptyStateCard snapshotStatus="ready" availability="unavailable" />);
    expect(screen.getByTestId('operations-empty-state')).toHaveTextContent(/unavailable/i);
  });

  it('shows partial-data message when visibility is incomplete', () => {
    render(<EmptyStateCard snapshotStatus="ready" availability="partial" />);
    expect(screen.getByTestId('operations-empty-state')).toHaveTextContent(/partially available/i);
  });

  it('shows no-match message for ready+ready (filtered to empty)', () => {
    render(<EmptyStateCard snapshotStatus="ready" availability="ready" />);
    expect(screen.getByTestId('operations-empty-state')).toHaveTextContent(/no matching/i);
  });
});

// ─── QueueItemCard ──────────────────────────────────────────────────────────

describe('QueueItemCard basics', () => {
  it('renders item title', () => {
    render(
      <QueueItemCard
        item={makeItem()}
        isSelected={false}
        hasPendingControl={false}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText('Refactor auth module')).toBeInTheDocument();
  });

  it('renders status badge with status text', () => {
    render(
      <QueueItemCard
        item={makeItem({ status: 'paused' })}
        isSelected={false}
        hasPendingControl={false}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText('paused')).toBeInTheDocument();
  });
});

describe('QueueItemCard selection', () => {
  it('has aria-current true when selected', () => {
    render(
      <QueueItemCard
        item={makeItem()}
        isSelected={true}
        hasPendingControl={false}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByRole('button')).toHaveAttribute('aria-current', 'true');
  });

  it('applies the selected ring when selected', () => {
    render(
      <QueueItemCard
        item={makeItem()}
        isSelected={true}
        hasPendingControl={false}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByRole('button')).toHaveStyle({
      boxShadow: '0 0 0 2px rgba(56, 189, 248, 0.5)',
    });
  });

  it('omits aria-current when not selected', () => {
    render(
      <QueueItemCard
        item={makeItem()}
        isSelected={false}
        hasPendingControl={false}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByRole('button')).not.toHaveAttribute('aria-current');
  });
});

describe('QueueItemCard metadata labels', () => {
  it('shows owner label when present', () => {
    render(
      <QueueItemCard
        item={makeItem({ ownerLabel: 'claude' })}
        isSelected={false}
        hasPendingControl={false}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText(/claude/)).toBeInTheDocument();
  });

  it('shows last checkpoint summary when present', () => {
    render(
      <QueueItemCard
        item={makeItem({ lastCheckpointSummary: 'Tests passing' })}
        isSelected={false}
        hasPendingControl={false}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText('Tests passing')).toBeInTheDocument();
  });
});

describe('QueueItemCard metadata', () => {
  it('renders risk signal summaries', () => {
    render(
      <QueueItemCard
        item={makeItem({
          riskSignals: [
            { kind: 'budget', severity: 'warning', summary: 'Budget 80% used', scope: 'global' },
          ],
        })}
        isSelected={false}
        hasPendingControl={false}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText(/Global\s*:\s*Budget 80% used/)).toBeInTheDocument();
  });

  it('shows pending control indicator', () => {
    render(
      <QueueItemCard
        item={makeItem()}
        isSelected={false}
        hasPendingControl={true}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText(/control pending/i)).toBeInTheDocument();
  });

  it('shows conversation link hint when relatedConversationId present', () => {
    render(
      <QueueItemCard
        item={makeItem({ relatedConversationId: 'conv-1' })}
        isSelected={false}
        hasPendingControl={false}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText(/linked to conversation/i)).toBeInTheDocument();
  });
});

describe('QueueItemCard interactions', () => {
  it('fires onSelect when clicked', () => {
    const onSelect = vi.fn();
    render(
      <QueueItemCard
        item={makeItem()}
        isSelected={false}
        hasPendingControl={false}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onSelect).toHaveBeenCalledOnce();
  });
});

// ─── QueuePanel ─────────────────────────────────────────────────────────────

describe('QueuePanel', () => {
  it('renders queue item cards inside a list', () => {
    const items = [
      makeItem({ id: 'wi-1', title: 'Task A' }),
      makeItem({ id: 'wi-2', title: 'Task B' }),
    ];
    render(
      <QueuePanel
        items={items}
        snapshotStatus="ready"
        availability="ready"
        selectedWorkItemId={null}
        onSelectItem={vi.fn()}
        hasPendingControl={() => false}
      />,
    );
    expect(screen.getByRole('list')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('Task A')).toBeInTheDocument();
    expect(screen.getByText('Task B')).toBeInTheDocument();
  });

  it('shows empty state when items array is empty', () => {
    render(
      <QueuePanel
        items={[]}
        snapshotStatus="ready"
        availability="empty"
        selectedWorkItemId={null}
        onSelectItem={vi.fn()}
        hasPendingControl={() => false}
      />,
    );
    expect(screen.getByTestId('operations-empty-state')).toHaveTextContent(/no work items/i);
  });

  it('highlights the selected item via aria-current', () => {
    const items = [makeItem({ id: 'wi-1' }), makeItem({ id: 'wi-2', title: 'Second' })];
    render(
      <QueuePanel
        items={items}
        snapshotStatus="ready"
        availability="ready"
        selectedWorkItemId="wi-1"
        onSelectItem={vi.fn()}
        hasPendingControl={() => false}
      />,
    );
    const buttons = screen.getAllByRole('button');
    expect(buttons[0]).toHaveAttribute('aria-current', 'true');
    expect(buttons[1]).not.toHaveAttribute('aria-current');
  });

  it('calls onSelectItem with item id when card is clicked', () => {
    const onSelectItem = vi.fn();
    const items = [makeItem({ id: 'wi-42', title: 'Click me' })];
    render(
      <QueuePanel
        items={items}
        snapshotStatus="ready"
        availability="ready"
        selectedWorkItemId={null}
        onSelectItem={onSelectItem}
        hasPendingControl={() => false}
      />,
    );
    fireEvent.click(screen.getByText('Click me'));
    expect(onSelectItem).toHaveBeenCalledWith('wi-42');
  });
});

// ─── OperationsPanelShell ───────────────────────────────────────────────────

describe('OperationsPanelShell', () => {
  it('renders heading and children', () => {
    render(
      <OperationsPanelShell snapshotStatus="ready" freshness="live">
        <p>Queue content</p>
      </OperationsPanelShell>,
    );
    expect(screen.getByRole('heading', { name: /operations/i })).toBeInTheDocument();
    expect(screen.getByText('Queue content')).toBeInTheDocument();
  });

  it('shows freshness badge', () => {
    render(
      <OperationsPanelShell snapshotStatus="ready" freshness="stale">
        <p>Content</p>
      </OperationsPanelShell>,
    );
    expect(screen.getByText('stale')).toBeInTheDocument();
  });

  it('shows live freshness badge', () => {
    render(
      <OperationsPanelShell snapshotStatus="ready" freshness="live">
        <p>Content</p>
      </OperationsPanelShell>,
    );
    expect(screen.getByText('live')).toBeInTheDocument();
  });

  it('shows refreshing indicator when snapshot is loading', () => {
    render(
      <OperationsPanelShell snapshotStatus="loading" freshness="refreshing">
        <p>Content</p>
      </OperationsPanelShell>,
    );
    expect(screen.getByText('Refreshing\u2026')).toBeInTheDocument();
  });

  it('labels section with operations heading', () => {
    render(
      <OperationsPanelShell snapshotStatus="idle" freshness="stale">
        <p>Content</p>
      </OperationsPanelShell>,
    );
    const section = screen.getByRole('region', { name: /operations/i });
    expect(section).toBeInTheDocument();
  });
});

// ─── T024 Regression: dense metadata rendering and shell layout ──────────────

describe('T024 QueueItemCard dense metadata regressions', () => {
  it('renders a long title without crashing or losing the status badge', () => {
    const longTitle = 'A'.repeat(200);
    render(
      <QueueItemCard
        item={makeItem({ title: longTitle })}
        isSelected={false}
        hasPendingControl={false}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText(longTitle)).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.getByRole('button')).toBeInTheDocument();
  });

  it('renders multiple risk signals without layout collapse', () => {
    render(
      <QueueItemCard
        item={makeItem({
          riskSignals: [
            { kind: 'budget', severity: 'warning', summary: 'Budget 80% used', scope: 'global' },
            {
              kind: 'health',
              severity: 'critical',
              summary: 'Agent unresponsive',
              scope: 'work-item',
            },
            { kind: 'budget', severity: 'info', summary: 'Token ceiling OK', scope: 'session' },
          ],
        })}
        isSelected={false}
        hasPendingControl={false}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText(/Global\s*:\s*Budget 80% used/)).toBeInTheDocument();
    expect(screen.getByText(/Work item\s*:\s*Agent unresponsive/)).toBeInTheDocument();
    expect(screen.getByText(/Session\s*:\s*Token ceiling OK/)).toBeInTheDocument();
    // All risk badges have distinct test IDs
    expect(screen.getByTestId('risk-badge-budget-global')).toBeInTheDocument();
    expect(screen.getByTestId('risk-badge-health-work-item')).toBeInTheDocument();
    expect(screen.getByTestId('risk-badge-budget-session')).toBeInTheDocument();
  });

  it('renders all metadata simultaneously: owner + checkpoint + risk + pending + conversation', () => {
    render(
      <QueueItemCard
        item={makeItem({
          ownerLabel: 'gemini',
          lastCheckpointSummary: 'CI green',
          relatedConversationId: 'conv-99',
          riskSignals: [
            {
              kind: 'health',
              severity: 'warning',
              summary: 'Slow response',
              scope: 'global',
            },
          ],
        })}
        isSelected={true}
        hasPendingControl={true}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText(/gemini/)).toBeInTheDocument();
    expect(screen.getByText('CI green')).toBeInTheDocument();
    expect(screen.getByText(/linked to conversation/i)).toBeInTheDocument();
    expect(screen.getByText(/control pending/i)).toBeInTheDocument();
    expect(screen.getByText(/Global\s*:\s*Slow response/)).toBeInTheDocument();
    expect(screen.getByRole('button')).toHaveAttribute('aria-current', 'true');
  });

  it('applies correct status colours for every work item status', () => {
    const expectedColors: Record<
      'waiting' | 'active' | 'paused' | 'blocked' | 'completed' | 'failed' | 'cancelled',
      string
    > = {
      waiting: 'rgb(251, 191, 36)',
      active: 'rgb(56, 189, 248)',
      paused: 'rgb(251, 146, 60)',
      blocked: 'rgb(248, 113, 113)',
      completed: 'rgb(74, 222, 128)',
      failed: 'rgb(239, 68, 68)',
      cancelled: 'rgb(148, 163, 184)',
    };
    const statuses: Array<
      'waiting' | 'active' | 'paused' | 'blocked' | 'completed' | 'failed' | 'cancelled'
    > = ['waiting', 'active', 'paused', 'blocked', 'completed', 'failed', 'cancelled'];

    for (const status of statuses) {
      cleanup();
      render(
        <QueueItemCard
          item={makeItem({ id: `wi-${status}`, status })}
          isSelected={false}
          hasPendingControl={false}
          onSelect={vi.fn()}
        />,
      );
      const badge = screen.getByText(status);
      expect(badge).toBeInTheDocument();
      expect(badge).toHaveStyle({ color: expectedColors[status] });
      expect(screen.getByRole('button')).toBeInTheDocument();
    }
  });
});

describe('T024 QueuePanel density regressions', () => {
  it('renders 10 items with correct list count', () => {
    const items = Array.from({ length: 10 }, (_, i) =>
      makeItem({ id: `wi-${i}`, title: `Task ${i}`, position: i }),
    );
    render(
      <QueuePanel
        items={items}
        snapshotStatus="ready"
        availability="ready"
        selectedWorkItemId={null}
        onSelectItem={vi.fn()}
        hasPendingControl={() => false}
      />,
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(10);
    expect(screen.getByRole('list')).toHaveAttribute('aria-label', 'Work queue');
  });

  it('preserves list accessibility label with mixed pending-control states', () => {
    const items = [
      makeItem({ id: 'wi-1', title: 'Normal' }),
      makeItem({ id: 'wi-2', title: 'Pending' }),
      makeItem({ id: 'wi-3', title: 'Also normal' }),
    ];
    render(
      <QueuePanel
        items={items}
        snapshotStatus="ready"
        availability="ready"
        selectedWorkItemId="wi-2"
        onSelectItem={vi.fn()}
        hasPendingControl={(id) => id === 'wi-2'}
      />,
    );

    // Verify all items rendered
    expect(screen.getByText('Normal')).toBeInTheDocument();
    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.getByText('Also normal')).toBeInTheDocument();

    // The pending item shows the control pending indicator
    expect(screen.getByText(/control pending/i)).toBeInTheDocument();

    // Selection is correct
    const buttons = screen.getAllByRole('button');
    expect(buttons[1]).toHaveAttribute('aria-current', 'true');
  });

  it('transitions from list to empty state when items go from populated to empty', () => {
    const { rerender } = render(
      <QueuePanel
        items={[makeItem({ id: 'wi-1', title: 'Vanishing' })]}
        snapshotStatus="ready"
        availability="ready"
        selectedWorkItemId={null}
        onSelectItem={vi.fn()}
        hasPendingControl={() => false}
      />,
    );
    expect(screen.getByText('Vanishing')).toBeInTheDocument();
    expect(screen.getByRole('list')).toBeInTheDocument();

    rerender(
      <QueuePanel
        items={[]}
        snapshotStatus="ready"
        availability="empty"
        selectedWorkItemId={null}
        onSelectItem={vi.fn()}
        hasPendingControl={() => false}
      />,
    );
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(screen.getByTestId('operations-empty-state')).toHaveTextContent(/no work items/i);
  });
});

describe('T024 OperationsPanelShell layout regressions', () => {
  it('renders detail panel slot alongside queue content', () => {
    render(
      <OperationsPanelShell
        snapshotStatus="ready"
        freshness="live"
        detailPanel={<div data-testid="mock-detail">Detail view</div>}
      >
        <p>Queue content</p>
      </OperationsPanelShell>,
    );
    expect(screen.getByText('Queue content')).toBeInTheDocument();
    expect(screen.getByTestId('detail-panel-slot')).toBeInTheDocument();
    expect(screen.getByTestId('mock-detail')).toHaveTextContent('Detail view');
    expect(screen.getByTestId('detail-panel-slot').parentElement).toHaveStyle({
      gridTemplateColumns: '1fr 1fr',
    });
  });

  it('renders health-budget slot above queue when provided', () => {
    render(
      <OperationsPanelShell
        snapshotStatus="ready"
        freshness="live"
        healthBudgetPanel={<div data-testid="mock-health">Health info</div>}
      >
        <p>Queue content</p>
      </OperationsPanelShell>,
    );
    expect(screen.getByTestId('health-budget-slot')).toBeInTheDocument();
    expect(screen.getByTestId('mock-health')).toHaveTextContent('Health info');
  });

  it('renders control strip slot inside detail panel', () => {
    render(
      <OperationsPanelShell
        snapshotStatus="ready"
        freshness="live"
        detailPanel={<div>Detail</div>}
        controlStripSlot={<div data-testid="mock-controls">Controls here</div>}
      >
        <p>Queue</p>
      </OperationsPanelShell>,
    );
    expect(screen.getByTestId('control-strip-slot')).toBeInTheDocument();
    expect(screen.getByTestId('mock-controls')).toHaveTextContent('Controls here');
  });

  it('does not render control strip slot when detail panel is absent', () => {
    render(
      <OperationsPanelShell
        snapshotStatus="ready"
        freshness="live"
        controlStripSlot={<div data-testid="mock-controls">Controls here</div>}
      >
        <p>Queue</p>
      </OperationsPanelShell>,
    );
    expect(screen.queryByTestId('detail-panel-slot')).not.toBeInTheDocument();
    expect(screen.queryByTestId('control-strip-slot')).not.toBeInTheDocument();
  });

  it('renders all three freshness states with correct text', () => {
    const states: Array<'live' | 'stale' | 'refreshing'> = ['live', 'stale', 'refreshing'];
    for (const freshness of states) {
      cleanup();
      render(
        <OperationsPanelShell snapshotStatus="ready" freshness={freshness}>
          <p>Content</p>
        </OperationsPanelShell>,
      );
      expect(screen.getByText(freshness)).toBeInTheDocument();
    }
  });
});
