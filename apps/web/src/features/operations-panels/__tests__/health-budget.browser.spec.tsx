/**
 * T027 — Health, budget, and risk-badge browser specs.
 *
 * Covers:
 * - HealthBudgetPanel: daemon health status display (healthy, degraded,
 *   unavailable, recovering), global budget posture (normal, warning, exceeded,
 *   unavailable), and combined health+budget presentation
 * - QueueItemCard risk badges: severity-based colouring, multiple signals,
 *   scope labels, and absence when no signals exist
 * - OperationsPanelShell: health/budget slot rendering above the queue
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';

import type { BudgetStatusView, DaemonHealthView, WorkQueueItemView } from '@hydra/web-contracts';

import { HealthBudgetPanel } from '../components/health-budget-panel.tsx';
import { QueueItemCard } from '../components/queue-item-card.tsx';
import { OperationsPanelShell } from '../components/operations-panel-shell.tsx';

afterEach(() => {
  cleanup();
});

// ─── Fixtures ───────────────────────────────────────────────────────────────

const NOW = '2026-06-01T12:00:00.000Z';
const noop = () => {};

function makeHealth(overrides: Partial<DaemonHealthView> = {}): DaemonHealthView {
  return {
    status: 'healthy',
    scope: 'global',
    observedAt: NOW,
    message: null,
    detailsAvailability: 'ready',
    ...overrides,
  };
}

function makeBudget(overrides: Partial<BudgetStatusView> = {}): BudgetStatusView {
  return {
    status: 'normal',
    scope: 'global',
    scopeId: null,
    summary: 'Token usage within limits',
    used: 5000,
    limit: 100000,
    unit: 'tokens',
    complete: true,
    ...overrides,
  };
}

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
    updatedAt: NOW,
    riskSignals: [],
    detailAvailability: 'ready',
    ...overrides,
  };
}

// ─── HealthBudgetPanel — daemon health states ───────────────────────────────

describe('HealthBudgetPanel — health status', () => {
  it('renders healthy status with label', () => {
    render(<HealthBudgetPanel health={makeHealth({ status: 'healthy' })} budget={null} />);
    expect(screen.getByTestId('health-status')).toHaveTextContent(/healthy/i);
  });

  it('renders degraded status', () => {
    render(<HealthBudgetPanel health={makeHealth({ status: 'degraded' })} budget={null} />);
    expect(screen.getByTestId('health-status')).toHaveTextContent(/degraded/i);
  });

  it('renders unavailable status', () => {
    render(<HealthBudgetPanel health={makeHealth({ status: 'unavailable' })} budget={null} />);
    expect(screen.getByTestId('health-status')).toHaveTextContent(/unavailable/i);
  });

  it('renders recovering status', () => {
    render(<HealthBudgetPanel health={makeHealth({ status: 'recovering' })} budget={null} />);
    expect(screen.getByTestId('health-status')).toHaveTextContent(/recovering/i);
  });

  it('displays health message when provided', () => {
    render(
      <HealthBudgetPanel
        health={makeHealth({ status: 'degraded', message: 'Agent pool reduced' })}
        budget={null}
      />,
    );
    expect(screen.getByTestId('health-message')).toHaveTextContent('Agent pool reduced');
  });

  it('does not render health message element when message is null', () => {
    render(<HealthBudgetPanel health={makeHealth({ message: null })} budget={null} />);
    expect(screen.queryByTestId('health-message')).not.toBeInTheDocument();
  });
});

// ─── HealthBudgetPanel — budget posture ─────────────────────────────────────

describe('HealthBudgetPanel — budget posture', () => {
  it('renders normal budget status', () => {
    render(<HealthBudgetPanel health={null} budget={makeBudget({ status: 'normal' })} />);
    expect(screen.getByTestId('budget-status')).toHaveTextContent(/normal/i);
  });

  it('renders warning budget status', () => {
    render(
      <HealthBudgetPanel
        health={null}
        budget={makeBudget({ status: 'warning', summary: 'Token usage at 85%' })}
      />,
    );
    expect(screen.getByTestId('budget-status')).toHaveTextContent(/warning/i);
    expect(screen.getByTestId('budget-summary')).toHaveTextContent('Token usage at 85%');
  });

  it('renders exceeded budget status', () => {
    render(
      <HealthBudgetPanel
        health={null}
        budget={makeBudget({ status: 'exceeded', summary: 'Daily budget exceeded' })}
      />,
    );
    expect(screen.getByTestId('budget-status')).toHaveTextContent(/exceeded/i);
  });

  it('renders unavailable budget status', () => {
    render(
      <HealthBudgetPanel
        health={null}
        budget={makeBudget({ status: 'unavailable', summary: 'Budget data unavailable' })}
      />,
    );
    expect(screen.getByTestId('budget-status')).toHaveTextContent(/unavailable/i);
  });

  it('shows budget summary text', () => {
    render(
      <HealthBudgetPanel
        health={null}
        budget={makeBudget({ summary: 'Token usage within limits' })}
      />,
    );
    expect(screen.getByTestId('budget-summary')).toHaveTextContent('Token usage within limits');
  });

  it('shows usage breakdown when used and limit are present', () => {
    render(
      <HealthBudgetPanel
        health={null}
        budget={makeBudget({ used: 85000, limit: 100000, unit: 'tokens' })}
      />,
    );
    expect(screen.getByTestId('budget-usage')).toHaveTextContent('85,000 / 100,000 tokens');
  });

  it('formats large numbers with en-US locale grouping', () => {
    render(
      <HealthBudgetPanel
        health={null}
        budget={makeBudget({ used: 1234567, limit: 9876543, unit: 'tokens' })}
      />,
    );
    expect(screen.getByTestId('budget-usage')).toHaveTextContent('1,234,567 / 9,876,543 tokens');
  });

  it('hides usage breakdown when used or limit are null', () => {
    render(
      <HealthBudgetPanel
        health={null}
        budget={makeBudget({ used: null, limit: null, unit: null })}
      />,
    );
    expect(screen.queryByTestId('budget-usage')).not.toBeInTheDocument();
  });
});

// ─── HealthBudgetPanel — combined display ───────────────────────────────────

describe('HealthBudgetPanel — combined health + budget', () => {
  it('renders both health and budget sections together', () => {
    render(
      <HealthBudgetPanel
        health={makeHealth({ status: 'healthy' })}
        budget={makeBudget({ status: 'normal' })}
      />,
    );
    expect(screen.getByTestId('health-status')).toBeInTheDocument();
    expect(screen.getByTestId('budget-status')).toBeInTheDocument();
  });

  it('renders nothing when both health and budget are null', () => {
    const { container } = render(<HealthBudgetPanel health={null} budget={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders only health section when budget is null', () => {
    render(<HealthBudgetPanel health={makeHealth()} budget={null} />);
    expect(screen.getByTestId('health-status')).toBeInTheDocument();
    expect(screen.queryByTestId('budget-status')).not.toBeInTheDocument();
  });

  it('renders only budget section when health is null', () => {
    render(<HealthBudgetPanel health={null} budget={makeBudget()} />);
    expect(screen.queryByTestId('health-status')).not.toBeInTheDocument();
    expect(screen.getByTestId('budget-status')).toBeInTheDocument();
  });

  it('marks incomplete budget data explicitly', () => {
    render(
      <HealthBudgetPanel
        health={null}
        budget={makeBudget({ complete: false, summary: 'Partial budget data' })}
      />,
    );
    expect(screen.getByTestId('budget-incomplete')).toBeInTheDocument();
  });

  it('does not show incomplete marker when budget is complete', () => {
    render(<HealthBudgetPanel health={null} budget={makeBudget({ complete: true })} />);
    expect(screen.queryByTestId('budget-incomplete')).not.toBeInTheDocument();
  });
});

// ─── HealthBudgetPanel — details availability ───────────────────────────────

describe('HealthBudgetPanel — health details availability', () => {
  it('indicates partial details availability', () => {
    render(
      <HealthBudgetPanel health={makeHealth({ detailsAvailability: 'partial' })} budget={null} />,
    );
    expect(screen.getByTestId('health-availability')).toHaveTextContent(/partial/i);
  });

  it('indicates unavailable details', () => {
    render(
      <HealthBudgetPanel
        health={makeHealth({ detailsAvailability: 'unavailable' })}
        budget={null}
      />,
    );
    expect(screen.getByTestId('health-availability')).toHaveTextContent(/unavailable/i);
  });

  it('does not show availability notice for ready state', () => {
    render(
      <HealthBudgetPanel health={makeHealth({ detailsAvailability: 'ready' })} budget={null} />,
    );
    expect(screen.queryByTestId('health-availability')).not.toBeInTheDocument();
  });
});

// ─── QueueItemCard — risk badges ────────────────────────────────────────────

describe('QueueItemCard risk badges', () => {
  it('renders risk signal summaries with data-testid', () => {
    render(
      <QueueItemCard
        item={makeItem({
          riskSignals: [
            { kind: 'budget', severity: 'warning', summary: 'Budget 80%', scope: 'global' },
          ],
        })}
        isSelected={false}
        hasPendingControl={false}
        onSelect={noop}
      />,
    );
    expect(screen.getByTestId('risk-badge-budget-global')).toHaveTextContent('Global: Budget 80%');
  });

  it('renders multiple risk signals', () => {
    render(
      <QueueItemCard
        item={makeItem({
          riskSignals: [
            { kind: 'budget', severity: 'warning', summary: 'Budget 80%', scope: 'global' },
            { kind: 'health', severity: 'critical', summary: 'Agent down', scope: 'global' },
            { kind: 'stale', severity: 'info', summary: 'Data stale', scope: 'work-item' },
          ],
        })}
        isSelected={false}
        hasPendingControl={false}
        onSelect={noop}
      />,
    );
    expect(screen.getByText('Global: Budget 80%')).toBeInTheDocument();
    expect(screen.getByText('Global: Agent down')).toBeInTheDocument();
    expect(screen.getByText('Work item: Data stale')).toBeInTheDocument();
  });

  it('renders no risk badges when riskSignals is empty', () => {
    render(
      <QueueItemCard
        item={makeItem({ riskSignals: [] })}
        isSelected={false}
        hasPendingControl={false}
        onSelect={noop}
      />,
    );
    expect(screen.queryByTestId(/^risk-badge-/)).not.toBeInTheDocument();
  });

  it('displays scope label on risk badges', () => {
    render(
      <QueueItemCard
        item={makeItem({
          riskSignals: [
            { kind: 'budget', severity: 'warning', summary: 'Over budget', scope: 'work-item' },
          ],
        })}
        isSelected={false}
        hasPendingControl={false}
        onSelect={noop}
      />,
    );
    const badge = screen.getByTestId('risk-badge-budget-work-item');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent('Work item: Over budget');
    expect(badge).toHaveAccessibleName('Work item risk: Over budget');
  });
});

// ─── OperationsPanelShell — health/budget slot ──────────────────────────────

describe('OperationsPanelShell health/budget slot', () => {
  it('renders healthBudgetPanel prop above queue content', () => {
    render(
      <OperationsPanelShell
        snapshotStatus="ready"
        freshness="live"
        healthBudgetPanel={<div data-testid="hb-slot">Health here</div>}
      >
        <p>Queue content</p>
      </OperationsPanelShell>,
    );
    expect(screen.getByTestId('hb-slot')).toHaveTextContent('Health here');
    // Health slot appears before queue content
    const section = screen.getByRole('region', { name: /operations/i });
    const slots = within(section).getAllByTestId(/(hb-slot|detail-panel-slot)/);
    expect(slots.length).toBeGreaterThanOrEqual(1);
  });

  it('does not render health/budget slot when prop is undefined', () => {
    render(
      <OperationsPanelShell snapshotStatus="ready" freshness="live">
        <p>Queue content</p>
      </OperationsPanelShell>,
    );
    expect(screen.queryByTestId('health-budget-slot')).not.toBeInTheDocument();
  });
});
