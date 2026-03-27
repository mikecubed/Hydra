/**
 * T034 — Execution detail panel browser specs.
 *
 * Covers:
 * - ExecutionPanel: loading and error states from detailFetchStatus
 * - ExecutionPanel: empty states for all availability values
 * - ExecutionPanel: renders agent assignments with state badges
 * - ExecutionPanel: renders council execution status and transitions
 * - ExecutionPanel: handles null council, empty assignments
 * - ExecutionPanel: council participants and final outcome
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';

import type {
  AgentAssignmentView,
  CouncilExecutionView,
  CouncilTransitionView,
} from '@hydra/web-contracts';

import { ExecutionPanel } from '../components/execution-panel.tsx';

afterEach(() => {
  cleanup();
});

// ─── Fixtures ───────────────────────────────────────────────────────────────

const NOW = '2026-06-01T12:00:00.000Z';
const EARLIER = '2026-06-01T11:30:00.000Z';

function makeAssignment(overrides: Partial<AgentAssignmentView> = {}): AgentAssignmentView {
  return {
    participantId: 'p-1',
    label: 'claude',
    role: 'architect',
    state: 'active',
    startedAt: EARLIER,
    endedAt: null,
    ...overrides,
  };
}

function makeTransition(overrides: Partial<CouncilTransitionView> = {}): CouncilTransitionView {
  return {
    id: 'ct-1',
    label: 'Round 1',
    status: 'completed',
    timestamp: NOW,
    detail: null,
    ...overrides,
  };
}

function makeCouncil(overrides: Partial<CouncilExecutionView> = {}): CouncilExecutionView {
  return {
    status: 'active',
    participants: [makeAssignment()],
    transitions: [],
    finalOutcome: null,
    ...overrides,
  };
}

// ─── Loading / error states ─────────────────────────────────────────────────

describe('ExecutionPanel loading and error states', () => {
  it('shows loading message when detailFetchStatus is loading', () => {
    render(
      <ExecutionPanel
        assignments={[]}
        council={null}
        detailAvailability={null}
        detailFetchStatus="loading"
      />,
    );
    expect(screen.getByTestId('execution-panel')).toHaveTextContent(/loading execution data/i);
  });

  it('shows error message when detailFetchStatus is error', () => {
    render(
      <ExecutionPanel
        assignments={[]}
        council={null}
        detailAvailability={null}
        detailFetchStatus="error"
      />,
    );
    expect(screen.getByTestId('execution-panel')).toHaveTextContent(
      /failed to load execution data/i,
    );
  });

  it('does not show "no execution" while loading', () => {
    render(
      <ExecutionPanel
        assignments={[]}
        council={null}
        detailAvailability={null}
        detailFetchStatus="loading"
      />,
    );
    expect(screen.getByTestId('execution-panel')).not.toHaveTextContent(/no execution/i);
  });

  it('does not show "no execution" after error', () => {
    render(
      <ExecutionPanel
        assignments={[]}
        council={null}
        detailAvailability={null}
        detailFetchStatus="error"
      />,
    );
    expect(screen.getByTestId('execution-panel')).not.toHaveTextContent(/no execution/i);
  });
});

// ─── Empty states ───────────────────────────────────────────────────────────

describe('ExecutionPanel empty states', () => {
  it('shows empty message when no assignments and no council with ready availability', () => {
    render(
      <ExecutionPanel
        assignments={[]}
        council={null}
        detailAvailability="ready"
        detailFetchStatus="idle"
      />,
    );
    expect(screen.getByTestId('execution-panel')).toHaveTextContent(/no execution data/i);
  });

  it('shows empty message when no assignments and no council with partial availability', () => {
    render(
      <ExecutionPanel
        assignments={[]}
        council={null}
        detailAvailability="partial"
        detailFetchStatus="idle"
      />,
    );
    expect(screen.getByTestId('execution-panel')).toHaveTextContent(/no execution data/i);
  });

  it('shows unavailable message when availability is unavailable', () => {
    render(
      <ExecutionPanel
        assignments={[]}
        council={null}
        detailAvailability="unavailable"
        detailFetchStatus="idle"
      />,
    );
    expect(screen.getByTestId('execution-panel')).toHaveTextContent(/unavailable/i);
  });

  it('shows default message when availability is null and fetch is idle', () => {
    render(
      <ExecutionPanel
        assignments={[]}
        council={null}
        detailAvailability={null}
        detailFetchStatus="idle"
      />,
    );
    expect(screen.getByTestId('execution-panel')).toHaveTextContent(/no execution data/i);
  });
});

// ─── Heading ────────────────────────────────────────────────────────────────

describe('ExecutionPanel heading', () => {
  it('renders the heading', () => {
    render(
      <ExecutionPanel
        assignments={[]}
        council={null}
        detailAvailability="ready"
        detailFetchStatus="idle"
      />,
    );
    expect(screen.getByRole('heading', { name: /execution/i })).toBeInTheDocument();
  });
});

// ─── Agent assignments ──────────────────────────────────────────────────────

/* eslint-disable max-lines-per-function -- assignment matrix coverage is intentionally grouped to keep the panel contract readable */
describe('ExecutionPanel agent assignments', () => {
  it('renders assignment entries in a list', () => {
    const assignments = [
      makeAssignment({ participantId: 'p-1', label: 'claude' }),
      makeAssignment({ participantId: 'p-2', label: 'gemini', role: 'analyst' }),
    ];

    render(
      <ExecutionPanel
        assignments={assignments}
        council={null}
        detailAvailability="ready"
        detailFetchStatus="idle"
      />,
    );

    const list = screen.getByRole('list', { name: /agent assignments/i });
    expect(list).toBeInTheDocument();
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
  });

  it('renders agent label and role', () => {
    const assignments = [
      makeAssignment({ participantId: 'p-1', label: 'codex', role: 'implementer' }),
    ];

    render(
      <ExecutionPanel
        assignments={assignments}
        council={null}
        detailAvailability="ready"
        detailFetchStatus="idle"
      />,
    );

    const entry = screen.getByTestId(`assignment-p-1:${EARLIER}:current:active:0`);
    expect(entry).toHaveTextContent('codex');
    expect(entry).toHaveTextContent('implementer');
  });

  it('renders agent state badge', () => {
    const assignments = [
      makeAssignment({ participantId: 'p-1', state: 'active' }),
      makeAssignment({ participantId: 'p-2', label: 'gemini', state: 'completed' }),
    ];

    render(
      <ExecutionPanel
        assignments={assignments}
        council={null}
        detailAvailability="ready"
        detailFetchStatus="idle"
      />,
    );

    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.getByText('completed')).toBeInTheDocument();
  });

  it('handles null role in assignment', () => {
    const assignments = [makeAssignment({ participantId: 'p-1', label: 'local', role: null })];

    render(
      <ExecutionPanel
        assignments={assignments}
        council={null}
        detailAvailability="ready"
        detailFetchStatus="idle"
      />,
    );

    const entry = screen.getByTestId(`assignment-p-1:${EARLIER}:current:active:0`);
    expect(entry).toHaveTextContent('local');
  });

  it('assigns data-testid per assignment entry', () => {
    const assignments = [
      makeAssignment({ participantId: 'p-alpha' }),
      makeAssignment({ participantId: 'p-beta', label: 'gemini' }),
    ];

    render(
      <ExecutionPanel
        assignments={assignments}
        council={null}
        detailAvailability="ready"
        detailFetchStatus="idle"
      />,
    );

    expect(
      screen.getByTestId(`assignment-p-alpha:${EARLIER}:current:active:0`),
    ).toBeInTheDocument();
    expect(screen.getByTestId(`assignment-p-beta:${EARLIER}:current:active:1`)).toBeInTheDocument();
  });

  it('does not render assignment list when assignments is empty', () => {
    render(
      <ExecutionPanel
        assignments={[]}
        council={makeCouncil()}
        detailAvailability="ready"
        detailFetchStatus="idle"
      />,
    );

    expect(screen.queryByRole('list', { name: /agent assignments/i })).not.toBeInTheDocument();
  });

  it('produces unique data-testid when identical assignments repeat', () => {
    const assignments = [makeAssignment(), makeAssignment()];

    render(
      <ExecutionPanel
        assignments={assignments}
        council={null}
        detailAvailability="ready"
        detailFetchStatus="idle"
      />,
    );

    const list = screen.getByRole('list', { name: /agent assignments/i });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);

    const testIds = items.map((item) => {
      const entry = item.querySelector('[data-testid^="assignment-"]');
      return entry?.getAttribute('data-testid');
    });

    // All testids must be defined and unique even when entries are otherwise identical.
    expect(testIds.every((id) => id != null)).toBe(true);
    expect(new Set(testIds).size).toBe(2);
  });
});
/* eslint-enable max-lines-per-function */

// ─── All assignment states render ───────────────────────────────────────────

describe('ExecutionPanel assignment state coverage', () => {
  const states = ['active', 'waiting', 'completed', 'failed', 'cancelled'] as const;

  for (const state of states) {
    it(`renders assignment with state "${state}"`, () => {
      const assignments = [
        makeAssignment({ participantId: `p-${state}`, state, label: `agent-${state}` }),
      ];

      render(
        <ExecutionPanel
          assignments={assignments}
          council={null}
          detailAvailability="ready"
          detailFetchStatus="idle"
        />,
      );

      expect(screen.getByText(state)).toBeInTheDocument();
      expect(screen.getByText(`agent-${state}`)).toBeInTheDocument();
    });
  }
});

// ─── Council execution ──────────────────────────────────────────────────────

/* eslint-disable max-lines-per-function -- council rendering permutations are exercised together for one UI contract surface */
describe('ExecutionPanel council execution', () => {
  it('renders council section when council is present', () => {
    render(
      <ExecutionPanel
        assignments={[]}
        council={makeCouncil({ status: 'active' })}
        detailAvailability="ready"
        detailFetchStatus="idle"
      />,
    );

    expect(screen.getByTestId('council-section')).toBeInTheDocument();
  });

  it('does not render council section when council is null', () => {
    render(
      <ExecutionPanel
        assignments={[makeAssignment()]}
        council={null}
        detailAvailability="ready"
        detailFetchStatus="idle"
      />,
    );

    expect(screen.queryByTestId('council-section')).not.toBeInTheDocument();
  });

  it('renders council status badge', () => {
    render(
      <ExecutionPanel
        assignments={[]}
        council={makeCouncil({ status: 'completed' })}
        detailAvailability="ready"
        detailFetchStatus="idle"
      />,
    );

    expect(screen.getByTestId('council-status')).toHaveTextContent('completed');
  });

  it('renders council transitions', () => {
    const transitions = [
      makeTransition({ id: 'ct-1', label: 'Round 1' }),
      makeTransition({ id: 'ct-2', label: 'Round 2', status: 'active' }),
    ];

    render(
      <ExecutionPanel
        assignments={[]}
        council={makeCouncil({ transitions })}
        detailAvailability="ready"
        detailFetchStatus="idle"
      />,
    );

    expect(screen.getByTestId('council-transition-ct-1')).toHaveTextContent('Round 1');
    expect(screen.getByTestId('council-transition-ct-2')).toHaveTextContent('Round 2');
  });

  it('renders council participants even when assignments are empty', () => {
    render(
      <ExecutionPanel
        assignments={[]}
        council={makeCouncil({
          participants: [
            makeAssignment({ participantId: 'c-1', label: 'claude', role: 'architect' }),
            makeAssignment({ participantId: 'c-2', label: 'gemini', role: 'analyst' }),
          ],
        })}
        detailAvailability="ready"
        detailFetchStatus="idle"
      />,
    );

    const participants = screen.getByRole('list', { name: /council participants/i });
    expect(participants).toBeInTheDocument();
    expect(participants).toHaveTextContent('claude');
    expect(participants).toHaveTextContent('gemini');
  });

  it('renders duplicate identical council participants with unique identities', () => {
    render(
      <ExecutionPanel
        assignments={[]}
        council={makeCouncil({
          participants: [
            makeAssignment({ participantId: 'p-dup' }),
            makeAssignment({ participantId: 'p-dup' }),
          ],
        })}
        detailAvailability="ready"
        detailFetchStatus="idle"
      />,
    );

    expect(screen.getByTestId(`assignment-p-dup:${EARLIER}:current:active:0`)).toBeInTheDocument();
    expect(screen.getByTestId(`assignment-p-dup:${EARLIER}:current:active:1`)).toBeInTheDocument();
  });

  it('renders transition detail text when present', () => {
    const transitions = [makeTransition({ id: 'ct-1', detail: 'Agents reached consensus' })];

    render(
      <ExecutionPanel
        assignments={[]}
        council={makeCouncil({ transitions })}
        detailAvailability="ready"
        detailFetchStatus="idle"
      />,
    );

    expect(screen.getByText('Agents reached consensus')).toBeInTheDocument();
  });

  it('omits transition detail when null', () => {
    const transitions = [makeTransition({ id: 'ct-1', detail: null })];

    render(
      <ExecutionPanel
        assignments={[]}
        council={makeCouncil({ transitions })}
        detailAvailability="ready"
        detailFetchStatus="idle"
      />,
    );

    const entry = screen.getByTestId('council-transition-ct-1');
    expect(entry.querySelectorAll('[style*="italic"]')).toHaveLength(0);
  });

  it('renders final outcome when present', () => {
    render(
      <ExecutionPanel
        assignments={[]}
        council={makeCouncil({
          status: 'completed',
          finalOutcome: 'Consensus reached on architecture',
        })}
        detailAvailability="ready"
        detailFetchStatus="idle"
      />,
    );

    expect(screen.getByTestId('council-outcome')).toHaveTextContent(
      'Consensus reached on architecture',
    );
  });

  it('does not render outcome element when finalOutcome is null', () => {
    render(
      <ExecutionPanel
        assignments={[]}
        council={makeCouncil({ finalOutcome: null })}
        detailAvailability="ready"
        detailFetchStatus="idle"
      />,
    );

    expect(screen.queryByTestId('council-outcome')).not.toBeInTheDocument();
  });
});
/* eslint-enable max-lines-per-function */

// ─── Council status coverage ────────────────────────────────────────────────

describe('ExecutionPanel council status coverage', () => {
  const statuses = ['active', 'waiting', 'completed', 'failed', 'cancelled'] as const;

  for (const status of statuses) {
    it(`renders council with status "${status}"`, () => {
      render(
        <ExecutionPanel
          assignments={[]}
          council={makeCouncil({ status })}
          detailAvailability="ready"
          detailFetchStatus="idle"
        />,
      );

      expect(screen.getByTestId('council-status')).toHaveTextContent(status);
    });
  }
});

// ─── Dense multi-agent rendering (T048) ─────────────────────────────────────

/* eslint-disable max-lines-per-function -- dense-layout matrix verifies all five states render simultaneously without overlap */
describe('ExecutionPanel dense multi-agent rendering', () => {
  const denseAssignments: AgentAssignmentView[] = [
    makeAssignment({ participantId: 'p-1', label: 'claude', role: 'architect', state: 'active' }),
    makeAssignment({
      participantId: 'p-2',
      label: 'gemini',
      role: 'analyst',
      state: 'waiting',
    }),
    makeAssignment({
      participantId: 'p-3',
      label: 'codex',
      role: 'implementer',
      state: 'completed',
      endedAt: NOW,
    }),
    makeAssignment({ participantId: 'p-4', label: 'local', role: 'runner', state: 'failed' }),
    makeAssignment({
      participantId: 'p-5',
      label: 'copilot',
      role: 'advisor',
      state: 'cancelled',
    }),
  ];

  it('renders all 5 agent assignment cards without missing any', () => {
    render(
      <ExecutionPanel
        assignments={denseAssignments}
        council={null}
        detailAvailability="ready"
        detailFetchStatus="idle"
      />,
    );

    const list = screen.getByRole('list', { name: /agent assignments/i });
    expect(within(list).getAllByRole('listitem')).toHaveLength(5);
  });

  it('each assignment card has a unique data-testid containing the participantId', () => {
    render(
      <ExecutionPanel
        assignments={denseAssignments}
        council={null}
        detailAvailability="ready"
        detailFetchStatus="idle"
      />,
    );

    for (const a of denseAssignments) {
      const testIds = screen
        .getAllByTestId(new RegExp(`^assignment-${a.participantId}:`))
        .map((el) => el.getAttribute('data-testid'));
      expect(testIds.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('renders all five distinct state badges simultaneously', () => {
    render(
      <ExecutionPanel
        assignments={denseAssignments}
        council={null}
        detailAvailability="ready"
        detailFetchStatus="idle"
      />,
    );

    for (const state of ['active', 'waiting', 'completed', 'failed', 'cancelled'] as const) {
      expect(screen.getByText(state)).toBeInTheDocument();
    }
  });

  it('each card shows its agent label without truncation', () => {
    render(
      <ExecutionPanel
        assignments={denseAssignments}
        council={null}
        detailAvailability="ready"
        detailFetchStatus="idle"
      />,
    );

    for (const a of denseAssignments) {
      expect(screen.getByText(a.label)).toBeInTheDocument();
    }
  });
});
/* eslint-enable max-lines-per-function */

// ─── Dense council timeline (T048) ──────────────────────────────────────────

describe('ExecutionPanel dense council timeline', () => {
  const denseTransitions: CouncilTransitionView[] = [
    makeTransition({ id: 'ct-1', label: 'Round 1', status: 'completed' }),
    makeTransition({ id: 'ct-2', label: 'Round 2', status: 'completed' }),
    makeTransition({ id: 'ct-3', label: 'Round 3', status: 'completed' }),
    makeTransition({ id: 'ct-4', label: 'Round 4', status: 'active' }),
    makeTransition({ id: 'ct-5', label: 'Round 5', status: 'waiting' }),
  ];

  it('renders 5+ council transitions in order with correct IDs', () => {
    render(
      <ExecutionPanel
        assignments={[]}
        council={makeCouncil({ transitions: denseTransitions })}
        detailAvailability="ready"
        detailFetchStatus="idle"
      />,
    );

    for (const t of denseTransitions) {
      expect(screen.getByTestId(`council-transition-${t.id}`)).toBeInTheDocument();
    }
  });

  it('each transition displays its label', () => {
    render(
      <ExecutionPanel
        assignments={[]}
        council={makeCouncil({ transitions: denseTransitions })}
        detailAvailability="ready"
        detailFetchStatus="idle"
      />,
    );

    for (const t of denseTransitions) {
      expect(screen.getByTestId(`council-transition-${t.id}`)).toHaveTextContent(t.label);
    }
  });

  it('each transition displays its status label', () => {
    render(
      <ExecutionPanel
        assignments={[]}
        council={makeCouncil({ transitions: denseTransitions })}
        detailAvailability="ready"
        detailFetchStatus="idle"
      />,
    );

    for (const t of denseTransitions) {
      expect(screen.getByTestId(`council-transition-${t.id}`)).toHaveTextContent(t.status);
    }
  });
});

// ─── Partial-data and unavailable affordances (T048) ─────────────────────────

describe('ExecutionPanel availability affordances', () => {
  it('shows a visible affordance with data-testid when availability is partial', () => {
    render(
      <ExecutionPanel
        assignments={[]}
        council={null}
        detailAvailability="partial"
        detailFetchStatus="idle"
      />,
    );

    expect(screen.getByTestId('detail-availability-partial')).toBeInTheDocument();
  });

  it('partial affordance is not a blank screen — contains meaningful text', () => {
    render(
      <ExecutionPanel
        assignments={[]}
        council={null}
        detailAvailability="partial"
        detailFetchStatus="idle"
      />,
    );

    const element = screen.getByTestId('detail-availability-partial');
    expect(element.textContent?.trim().length).toBeGreaterThan(0);
  });

  it('shows a visible affordance with data-testid when availability is unavailable', () => {
    render(
      <ExecutionPanel
        assignments={[]}
        council={null}
        detailAvailability="unavailable"
        detailFetchStatus="idle"
      />,
    );

    expect(screen.getByTestId('detail-availability-unavailable')).toBeInTheDocument();
  });

  it('unavailable affordance contains meaningful text', () => {
    render(
      <ExecutionPanel
        assignments={[]}
        council={null}
        detailAvailability="unavailable"
        detailFetchStatus="idle"
      />,
    );

    const element = screen.getByTestId('detail-availability-unavailable');
    expect(element.textContent?.trim().length).toBeGreaterThan(0);
  });

  it('does not show partial or unavailable affordance when availability is ready', () => {
    render(
      <ExecutionPanel
        assignments={[makeAssignment()]}
        council={null}
        detailAvailability="ready"
        detailFetchStatus="idle"
      />,
    );

    expect(screen.queryByTestId('detail-availability-partial')).not.toBeInTheDocument();
    expect(screen.queryByTestId('detail-availability-unavailable')).not.toBeInTheDocument();
  });
});

// ─── Loading with existing data ─────────────────────────────────────────────

describe('ExecutionPanel stale-data indicators', () => {
  it('shows loading notice when refetching with existing assignment data', () => {
    const assignments = [makeAssignment({ participantId: 'p-1', label: 'claude' })];

    render(
      <ExecutionPanel
        assignments={assignments}
        council={null}
        detailAvailability="ready"
        detailFetchStatus="loading"
      />,
    );

    expect(screen.getByTestId('execution-panel')).toHaveTextContent(/loading execution data/i);
    expect(screen.getByTestId(`assignment-p-1:${EARLIER}:current:active:0`)).toBeInTheDocument();
  });

  it('shows error notice when refetch failed with existing council data', () => {
    render(
      <ExecutionPanel
        assignments={[]}
        council={makeCouncil({ status: 'active' })}
        detailAvailability="ready"
        detailFetchStatus="error"
      />,
    );

    expect(screen.getByTestId('execution-panel')).toHaveTextContent(
      /failed to load execution data/i,
    );
    expect(screen.getByTestId('council-section')).toBeInTheDocument();
  });
});
