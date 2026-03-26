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
