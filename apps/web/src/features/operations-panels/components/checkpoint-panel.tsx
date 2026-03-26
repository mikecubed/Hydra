/**
 * Checkpoint panel — renders the checkpoint timeline for a selected work item.
 *
 * Displays checkpoint records in sequence order with status badges, timestamps,
 * and optional detail text. Shows contextual empty states for loading, partial,
 * and unavailable detail availability.
 */
import type { CSSProperties, JSX } from 'react';
import type {
  CheckpointRecordView,
  CheckpointStatus,
  DetailAvailability,
} from '@hydra/web-contracts';
import type { DetailFetchStatus } from '../model/operations-types.ts';

// ─── Status colour map ──────────────────────────────────────────────────────

const checkpointStatusColors: Record<
  CheckpointStatus,
  { text: string; border: string; bg: string }
> = {
  reached: {
    text: '#4ade80',
    border: 'rgba(74, 222, 128, 0.25)',
    bg: 'rgba(74, 222, 128, 0.05)',
  },
  waiting: {
    text: '#fbbf24',
    border: 'rgba(251, 191, 36, 0.25)',
    bg: 'rgba(251, 191, 36, 0.05)',
  },
  resumed: {
    text: '#38bdf8',
    border: 'rgba(56, 189, 248, 0.25)',
    bg: 'rgba(56, 189, 248, 0.05)',
  },
  recovered: {
    text: '#a78bfa',
    border: 'rgba(167, 139, 250, 0.25)',
    bg: 'rgba(167, 139, 250, 0.05)',
  },
  skipped: {
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

function resolveEmptyMessage(
  availability: DetailAvailability | null,
  fetchStatus: DetailFetchStatus,
): string {
  if (fetchStatus === 'loading') return 'Loading checkpoint data\u2026';
  if (fetchStatus === 'error') return 'Failed to load checkpoint data.';
  if (availability === 'partial') return 'Checkpoint data is partially available.';
  if (availability === 'unavailable') return 'Checkpoint data is currently unavailable.';
  return 'No checkpoints recorded yet.';
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function CheckpointStatusBadge({ status }: { readonly status: CheckpointStatus }): JSX.Element {
  const palette = checkpointStatusColors[status];
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

function CheckpointEntry({
  checkpoint,
}: {
  readonly checkpoint: CheckpointRecordView;
}): JSX.Element {
  const palette = checkpointStatusColors[checkpoint.status];
  const entryStyle: CSSProperties = {
    border: `1px solid ${palette.border}`,
    borderRadius: '0.375rem',
    background: palette.bg,
    padding: '0.4rem 0.6rem',
    display: 'grid',
    gap: '0.2rem',
  };

  return (
    <div style={entryStyle} data-testid={`checkpoint-${checkpoint.id}`}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontWeight: 600, fontSize: '0.8rem', color: '#e2e8f0' }}>
          {checkpoint.label}
        </span>
        <CheckpointStatusBadge status={checkpoint.status} />
      </div>
      <span style={metaStyle}>{formatTimestamp(checkpoint.timestamp)}</span>
      {checkpoint.detail != null && <span style={detailTextStyle}>{checkpoint.detail}</span>}
    </div>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────

export interface CheckpointPanelProps {
  readonly checkpoints: readonly CheckpointRecordView[];
  readonly detailAvailability: DetailAvailability | null;
  readonly detailFetchStatus: DetailFetchStatus;
}

export function CheckpointPanel({
  checkpoints,
  detailAvailability,
  detailFetchStatus,
}: CheckpointPanelProps): JSX.Element {
  return (
    <div style={panelStyle} data-testid="checkpoint-panel">
      <h4 style={headingStyle}>Checkpoints</h4>
      {checkpoints.length === 0 ? (
        <p style={emptyStyle}>{resolveEmptyMessage(detailAvailability, detailFetchStatus)}</p>
      ) : (
        <ol aria-label="Checkpoint timeline" style={listStyle}>
          {checkpoints.map((cp) => (
            <li key={cp.id}>
              <CheckpointEntry checkpoint={cp} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
