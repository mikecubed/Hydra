/**
 * Individual work-queue item card.
 *
 * Renders title, status badge, optional owner/checkpoint/risk/conversation
 * metadata, and pending-control indicator. Follows the inline-style pattern
 * established by prompt-card.tsx in the chat workspace.
 */
import type { CSSProperties, JSX } from 'react';
import type { RiskSignalSeverity, WorkItemStatus, WorkQueueItemView } from '@hydra/web-contracts';

export interface QueueItemCardProps {
  readonly item: WorkQueueItemView;
  readonly isSelected: boolean;
  readonly hasPendingControl: boolean;
  readonly onSelect: () => void;
}

// ─── Status-based colour map ────────────────────────────────────────────────

const statusColors: Record<WorkItemStatus, { border: string; bg: string; text: string }> = {
  waiting: {
    border: 'rgba(251, 191, 36, 0.25)',
    bg: 'rgba(251, 191, 36, 0.05)',
    text: '#fbbf24',
  },
  active: {
    border: 'rgba(56, 189, 248, 0.25)',
    bg: 'rgba(56, 189, 248, 0.05)',
    text: '#38bdf8',
  },
  paused: {
    border: 'rgba(251, 146, 60, 0.25)',
    bg: 'rgba(251, 146, 60, 0.05)',
    text: '#fb923c',
  },
  blocked: {
    border: 'rgba(248, 113, 113, 0.25)',
    bg: 'rgba(248, 113, 113, 0.05)',
    text: '#f87171',
  },
  completed: {
    border: 'rgba(74, 222, 128, 0.25)',
    bg: 'rgba(74, 222, 128, 0.05)',
    text: '#4ade80',
  },
  failed: {
    border: 'rgba(239, 68, 68, 0.25)',
    bg: 'rgba(239, 68, 68, 0.05)',
    text: '#ef4444',
  },
  cancelled: {
    border: 'rgba(148, 163, 184, 0.2)',
    bg: 'rgba(148, 163, 184, 0.03)',
    text: '#94a3b8',
  },
};

const riskSeverityColors: Record<RiskSignalSeverity, string> = {
  info: '#94a3b8',
  warning: '#fbbf24',
  critical: '#f87171',
};

const selectedRingStyle = '0 0 0 2px rgba(56, 189, 248, 0.5)' as const;

function resolveCardStyle(
  status: WorkItemStatus,
  isSelected: boolean,
): CSSProperties {
  const palette = statusColors[status];
  return {
    // Button reset
    appearance: 'none',
    font: 'inherit',
    color: 'inherit',
    textAlign: 'left',
    width: '100%',
    // Card styles
    border: `1px solid ${palette.border}`,
    borderRadius: '0.375rem',
    background: palette.bg,
    padding: '0.5rem 0.75rem',
    cursor: 'pointer',
    display: 'grid',
    gap: '0.3rem',
    boxShadow: isSelected ? selectedRingStyle : 'none',
  };
}

const badgeBase: CSSProperties = {
  fontSize: '0.7rem',
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  padding: '0.1rem 0.4rem',
  borderRadius: '0.25rem',
};

function StatusBadge({ status }: { readonly status: WorkItemStatus }): JSX.Element {
  const palette = statusColors[status];
  return (
    <span
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

const pendingBadgeStyle: CSSProperties = {
  fontSize: '0.7rem',
  color: '#fbbf24',
  fontStyle: 'italic',
};

const metaStyle: CSSProperties = {
  fontSize: '0.75rem',
  color: '#94a3b8',
};

const hintStyle: CSSProperties = {
  fontSize: '0.7rem',
  color: '#64748b',
};

export function QueueItemCard({
  item,
  isSelected,
  hasPendingControl,
  onSelect,
}: QueueItemCardProps): JSX.Element {
  return (
    <button
      type="button"
      aria-current={isSelected || undefined}
      onClick={onSelect}
      style={resolveCardStyle(item.status, isSelected)}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>{item.title}</span>
        <StatusBadge status={item.status} />
      </div>

      {item.ownerLabel != null && <span style={metaStyle}>Owner: {item.ownerLabel}</span>}

      {item.lastCheckpointSummary != null && (
        <span style={metaStyle}>{item.lastCheckpointSummary}</span>
      )}

      {item.riskSignals.length > 0 && (
        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
          {item.riskSignals.map((signal, idx) => (
            <span
              key={`${signal.kind}-${String(idx)}`}
              style={{
                fontSize: '0.7rem',
                color: riskSeverityColors[signal.severity],
              }}
            >
              {signal.summary}
            </span>
          ))}
        </div>
      )}

      {hasPendingControl && <span style={pendingBadgeStyle}>Control pending</span>}

      {item.relatedConversationId != null && (
        <span style={hintStyle}>Linked to conversation</span>
      )}
    </button>
  );
}
