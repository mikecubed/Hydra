/**
 * Execution panel — renders agent assignments and council execution details
 * for a selected work item.
 *
 * Displays assigned agents with their roles and state badges, plus optional
 * council execution status, transitions, and final outcome. Shows contextual
 * empty states for loading, partial, and unavailable detail availability.
 */
import type { CSSProperties, JSX } from 'react';
import type {
  AgentAssignmentState,
  AgentAssignmentView,
  CouncilExecutionStatus,
  CouncilExecutionView,
  CouncilTransitionView,
  DetailAvailability,
} from '@hydra/web-contracts';
import type { DetailFetchStatus } from '../model/operations-types.ts';

// ─── Agent state colour map ─────────────────────────────────────────────────

const agentStateColors: Record<AgentAssignmentState, { text: string; border: string; bg: string }> =
  {
    active: {
      text: '#38bdf8',
      border: 'rgba(56, 189, 248, 0.25)',
      bg: 'rgba(56, 189, 248, 0.05)',
    },
    waiting: {
      text: '#fbbf24',
      border: 'rgba(251, 191, 36, 0.25)',
      bg: 'rgba(251, 191, 36, 0.05)',
    },
    completed: {
      text: '#4ade80',
      border: 'rgba(74, 222, 128, 0.25)',
      bg: 'rgba(74, 222, 128, 0.05)',
    },
    failed: {
      text: '#f87171',
      border: 'rgba(248, 113, 113, 0.25)',
      bg: 'rgba(248, 113, 113, 0.05)',
    },
    cancelled: {
      text: '#94a3b8',
      border: 'rgba(148, 163, 184, 0.2)',
      bg: 'rgba(148, 163, 184, 0.03)',
    },
  };

// ─── Council status colour map ──────────────────────────────────────────────

const councilStatusColors: Record<
  CouncilExecutionStatus,
  { text: string; border: string; bg: string }
> = {
  active: {
    text: '#38bdf8',
    border: 'rgba(56, 189, 248, 0.25)',
    bg: 'rgba(56, 189, 248, 0.05)',
  },
  waiting: {
    text: '#fbbf24',
    border: 'rgba(251, 191, 36, 0.25)',
    bg: 'rgba(251, 191, 36, 0.05)',
  },
  completed: {
    text: '#4ade80',
    border: 'rgba(74, 222, 128, 0.25)',
    bg: 'rgba(74, 222, 128, 0.05)',
  },
  failed: {
    text: '#f87171',
    border: 'rgba(248, 113, 113, 0.25)',
    bg: 'rgba(248, 113, 113, 0.05)',
  },
  cancelled: {
    text: '#94a3b8',
    border: 'rgba(148, 163, 184, 0.2)',
    bg: 'rgba(148, 163, 184, 0.03)',
  },
};

// ─── Styles ─────────────────────────────────────────────────────────────────

const panelStyle: CSSProperties = {
  display: 'grid',
  gap: '0.5rem',
};

const headingStyle: CSSProperties = {
  margin: 0,
  fontSize: '0.9rem',
  fontWeight: 600,
  color: '#e2e8f0',
};

const subHeadingStyle: CSSProperties = {
  margin: 0,
  fontSize: '0.8rem',
  fontWeight: 600,
  color: '#cbd5e1',
};

const listStyle: CSSProperties = {
  display: 'grid',
  gap: '0.375rem',
  margin: 0,
  padding: 0,
  listStyle: 'none',
};

const badgeBase: CSSProperties = {
  fontSize: '0.65rem',
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  padding: '0.1rem 0.35rem',
  borderRadius: '0.2rem',
};

const metaStyle: CSSProperties = {
  fontSize: '0.7rem',
  color: '#64748b',
};

const detailTextStyle: CSSProperties = {
  fontSize: '0.75rem',
  color: '#94a3b8',
  fontStyle: 'italic',
};

const emptyStyle: CSSProperties = {
  fontSize: '0.8rem',
  color: '#64748b',
  fontStyle: 'italic',
  margin: 0,
};

const councilSectionStyle: CSSProperties = {
  display: 'grid',
  gap: '0.375rem',
  padding: '0.5rem 0.75rem',
  borderRadius: '0.375rem',
};

const outcomeStyle: CSSProperties = {
  fontSize: '0.75rem',
  color: '#e2e8f0',
  padding: '0.3rem 0.5rem',
  background: 'rgba(74, 222, 128, 0.05)',
  border: '1px solid rgba(74, 222, 128, 0.15)',
  borderRadius: '0.25rem',
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatTimestamp(iso: string): string {
  try {
    const date = new Date(iso);
    return date.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return iso;
  }
}

function resolveStatusNotice(fetchStatus: DetailFetchStatus): string | null {
  if (fetchStatus === 'loading') return 'Loading execution data\u2026';
  if (fetchStatus === 'error') return 'Failed to load execution data.';
  return null;
}

function resolveEmptyMessage(
  availability: DetailAvailability | null,
  fetchStatus: DetailFetchStatus,
): string {
  const notice = resolveStatusNotice(fetchStatus);
  if (notice !== null) return notice;
  if (availability === 'unavailable') return 'Execution data is currently unavailable.';
  return 'No execution data recorded yet.';
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function AssignmentStateBadge({ state }: { readonly state: AgentAssignmentState }): JSX.Element {
  const palette = agentStateColors[state];
  return (
    <span
      style={{
        ...badgeBase,
        color: palette.text,
        background: palette.bg,
        border: `1px solid ${palette.border}`,
      }}
    >
      {state}
    </span>
  );
}

function AssignmentEntry({
  assignment,
}: {
  readonly assignment: AgentAssignmentView;
}): JSX.Element {
  const palette = agentStateColors[assignment.state];
  const assignmentEntryStyle: CSSProperties = {
    border: `1px solid ${palette.border}`,
    borderRadius: '0.375rem',
    background: palette.bg,
    padding: '0.4rem 0.6rem',
    display: 'grid',
    gap: '0.2rem',
  };

  return (
    <div style={assignmentEntryStyle} data-testid={`assignment-${assignment.participantId}`}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontWeight: 600, fontSize: '0.8rem', color: '#e2e8f0' }}>
          {assignment.label}
        </span>
        <AssignmentStateBadge state={assignment.state} />
      </div>
      {assignment.role != null && <span style={metaStyle}>{assignment.role}</span>}
      {assignment.startedAt != null && (
        <span style={metaStyle}>{formatTimestamp(assignment.startedAt)}</span>
      )}
    </div>
  );
}

function CouncilStatusBadge({ status }: { readonly status: CouncilExecutionStatus }): JSX.Element {
  const palette = councilStatusColors[status];
  return (
    <span
      data-testid="council-status"
      style={{
        ...badgeBase,
        color: palette.text,
        background: palette.bg,
        border: `1px solid ${palette.border}`,
      }}
    >
      {status}
    </span>
  );
}

function TransitionEntry({
  transition,
}: {
  readonly transition: CouncilTransitionView;
}): JSX.Element {
  return (
    <div
      style={{
        border: '1px solid rgba(148, 163, 184, 0.2)',
        borderRadius: '0.375rem',
        background: 'rgba(148, 163, 184, 0.03)',
        padding: '0.4rem 0.6rem',
        display: 'grid',
        gap: '0.2rem',
      }}
      data-testid={`council-transition-${transition.id}`}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontWeight: 600, fontSize: '0.8rem', color: '#e2e8f0' }}>
          {transition.label}
        </span>
        <span style={{ fontSize: '0.65rem', color: '#94a3b8' }}>{transition.status}</span>
      </div>
      <span style={metaStyle}>{formatTimestamp(transition.timestamp)}</span>
      {transition.detail != null && <span style={detailTextStyle}>{transition.detail}</span>}
    </div>
  );
}

function CouncilSection({ council }: { readonly council: CouncilExecutionView }): JSX.Element {
  const palette = councilStatusColors[council.status];
  const resolvedSectionStyle: CSSProperties = {
    ...councilSectionStyle,
    border: `1px solid ${palette.border}`,
    background: palette.bg,
  };

  return (
    <div style={resolvedSectionStyle} data-testid="council-section">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={subHeadingStyle}>Council</span>
        <CouncilStatusBadge status={council.status} />
      </div>
      {council.participants.length > 0 && (
        <div style={{ display: 'grid', gap: '0.25rem' }}>
          <span style={subHeadingStyle}>Participants</span>
          <ol aria-label="Council participants" style={listStyle}>
            {council.participants.map((participant) => (
              <li key={participant.participantId}>
                <AssignmentEntry assignment={participant} />
              </li>
            ))}
          </ol>
        </div>
      )}
      {council.transitions.length > 0 && (
        <div style={{ display: 'grid', gap: '0.25rem' }}>
          {council.transitions.map((t) => (
            <TransitionEntry key={t.id} transition={t} />
          ))}
        </div>
      )}
      {council.finalOutcome != null && (
        <span data-testid="council-outcome" style={outcomeStyle}>
          {council.finalOutcome}
        </span>
      )}
    </div>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────

export interface ExecutionPanelProps {
  readonly assignments: readonly AgentAssignmentView[];
  readonly council: CouncilExecutionView | null;
  readonly detailAvailability: DetailAvailability | null;
  readonly detailFetchStatus: DetailFetchStatus;
}

export function ExecutionPanel({
  assignments,
  council,
  detailAvailability,
  detailFetchStatus,
}: ExecutionPanelProps): JSX.Element {
  const statusNotice = resolveStatusNotice(detailFetchStatus);
  const hasData = assignments.length > 0 || council !== null;

  return (
    <div style={panelStyle} data-testid="execution-panel">
      <h4 style={headingStyle}>Execution</h4>
      {statusNotice !== null && <p style={emptyStyle}>{statusNotice}</p>}
      {!hasData && statusNotice === null && (
        <p style={emptyStyle}>{resolveEmptyMessage(detailAvailability, detailFetchStatus)}</p>
      )}
      {assignments.length > 0 && (
        <ol aria-label="Agent assignments" style={listStyle}>
          {assignments.map((a) => (
            <li key={a.participantId}>
              <AssignmentEntry assignment={a} />
            </li>
          ))}
        </ol>
      )}
      {council != null && <CouncilSection council={council} />}
    </div>
  );
}
