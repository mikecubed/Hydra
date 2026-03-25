/**
 * Queue panel — lists filtered work-queue items or an empty state.
 *
 * Receives pre-filtered items from the parent so it stays a pure
 * presentation component. Delegates individual card rendering to
 * QueueItemCard and empty-state rendering to EmptyStateCard.
 */
import type { JSX } from 'react';
import type {
  SnapshotStatus,
  WorkQueueItemView,
  WorkspaceAvailability,
} from '@hydra/web-contracts';

import { QueueItemCard } from './queue-item-card.tsx';
import { EmptyStateCard } from './empty-state-card.tsx';

export interface QueuePanelProps {
  readonly items: readonly WorkQueueItemView[];
  readonly snapshotStatus: SnapshotStatus;
  readonly availability: WorkspaceAvailability;
  readonly selectedWorkItemId: string | null;
  readonly onSelectItem: (workItemId: string) => void;
  readonly hasPendingControl: (workItemId: string) => boolean;
}

const listStyle = {
  display: 'grid',
  gap: '0.5rem',
} as const;

export function QueuePanel({
  items,
  snapshotStatus,
  availability,
  selectedWorkItemId,
  onSelectItem,
  hasPendingControl,
}: QueuePanelProps): JSX.Element {
  if (items.length === 0) {
    return <EmptyStateCard snapshotStatus={snapshotStatus} availability={availability} />;
  }

  return (
    <div role="list" style={listStyle}>
      {items.map((item) => (
        <QueueItemCard
          key={item.id}
          item={item}
          isSelected={item.id === selectedWorkItemId}
          hasPendingControl={hasPendingControl(item.id)}
          onSelect={() => onSelectItem(item.id)}
        />
      ))}
    </div>
  );
}
