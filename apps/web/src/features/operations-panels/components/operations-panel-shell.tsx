/**
 * Operations panel shell — top-level container for the operations sidebar.
 *
 * Renders the section heading, freshness badge, and optional loading
 * indicator. Children (currently the QueuePanel) are rendered below
 * the header.
 */
import type { JSX, ReactNode } from 'react';
import type {
  SnapshotStatus,
  WorkspaceAvailability,
  WorkspaceFreshness,
} from '@hydra/web-contracts';

export interface OperationsPanelShellProps {
  readonly snapshotStatus: SnapshotStatus;
  readonly freshness: WorkspaceFreshness;
  readonly availability: WorkspaceAvailability;
  readonly children: ReactNode;
}

const shellStyle: React.CSSProperties = {
  border: '1px solid rgba(148, 163, 184, 0.2)',
  borderRadius: '0.75rem',
  background: 'rgba(15, 23, 42, 0.55)',
  padding: '1rem',
  display: 'grid',
  gap: '0.75rem',
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
};

const freshnessBadgeBase: React.CSSProperties = {
  fontSize: '0.65rem',
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  padding: '0.1rem 0.4rem',
  borderRadius: '0.25rem',
};

const freshnessStyles: Record<WorkspaceFreshness, React.CSSProperties> = {
  live: {
    ...freshnessBadgeBase,
    color: '#4ade80',
    background: 'rgba(74, 222, 128, 0.1)',
    border: '1px solid rgba(74, 222, 128, 0.25)',
  },
  refreshing: {
    ...freshnessBadgeBase,
    color: '#38bdf8',
    background: 'rgba(56, 189, 248, 0.1)',
    border: '1px solid rgba(56, 189, 248, 0.25)',
  },
  stale: {
    ...freshnessBadgeBase,
    color: '#94a3b8',
    background: 'rgba(148, 163, 184, 0.1)',
    border: '1px solid rgba(148, 163, 184, 0.2)',
  },
};

const loadingLabelStyle: React.CSSProperties = {
  fontSize: '0.75rem',
  color: '#38bdf8',
  fontStyle: 'italic',
};

function FreshnessBadge({
  freshness,
}: {
  readonly freshness: WorkspaceFreshness;
}): JSX.Element {
  return <span style={freshnessStyles[freshness]}>{freshness}</span>;
}

export function OperationsPanelShell({
  snapshotStatus,
  freshness,
  children,
}: OperationsPanelShellProps): JSX.Element {
  return (
    <section aria-labelledby="operations-panel-heading" style={shellStyle}>
      <header style={headerStyle}>
        <h3 id="operations-panel-heading" style={{ margin: 0, fontSize: '1.1rem' }}>
          Operations
        </h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <FreshnessBadge freshness={freshness} />
          {snapshotStatus === 'loading' && <span style={loadingLabelStyle}>Refreshing…</span>}
        </div>
      </header>
      {children}
    </section>
  );
}
