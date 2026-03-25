/**
 * Empty-state card for the queue panel.
 *
 * Renders a contextual message when the work queue has nothing to show —
 * distinguished by snapshot lifecycle status and workspace availability so
 * the operator always understands *why* the queue is empty.
 */
import type { JSX } from 'react';
import type { SnapshotStatus, WorkspaceAvailability } from '@hydra/web-contracts';

export interface EmptyStateCardProps {
  readonly snapshotStatus: SnapshotStatus;
  readonly availability: WorkspaceAvailability;
}

const cardStyle = {
  border: '1px solid rgba(148, 163, 184, 0.15)',
  borderRadius: '0.5rem',
  background: 'rgba(148, 163, 184, 0.04)',
  padding: '1rem 1.25rem',
} as const;

function resolveMessage(
  snapshotStatus: SnapshotStatus,
  availability: WorkspaceAvailability,
): string {
  if (snapshotStatus === 'loading') return 'Loading operations snapshot\u2026';
  if (snapshotStatus === 'error')
    return 'Unable to load operations snapshot. The daemon may be unavailable.';
  if (snapshotStatus === 'idle') return 'Operations snapshot has not been requested yet.';
  if (availability === 'empty') return 'No work items in the queue.';
  if (availability === 'unavailable') return 'Operations data is currently unavailable.';
  return 'No matching work items.';
}

export function EmptyStateCard({
  snapshotStatus,
  availability,
}: EmptyStateCardProps): JSX.Element {
  return (
    <div data-testid="operations-empty-state" style={cardStyle}>
      <p style={{ margin: 0, lineHeight: 1.6, fontSize: '0.85rem', color: '#94a3b8' }}>
        {resolveMessage(snapshotStatus, availability)}
      </p>
    </div>
  );
}
