/**
 * Derived selectors for the operations panels workspace.
 *
 * Each selector extracts a commonly-needed slice of OperationsWorkspaceState
 * so UI components never duplicate map-lookup / filter plumbing. All functions
 * are pure — no hidden state, no side effects.
 */

import type {
  DaemonHealthView,
  OperationalControlView,
  SnapshotStatus,
  WorkItemStatus,
  WorkQueueItemView,
  WorkspaceAvailability,
  WorkspaceFreshness,
  GetWorkItemDetailResponse,
} from '@hydra/web-contracts';

import type { OperationsWorkspaceState } from './operations-types.ts';

const EMPTY_QUEUE: readonly WorkQueueItemView[] = [];
const EMPTY_CONTROLS: readonly OperationalControlView[] = [];

/** Current snapshot polling status. */
export function selectSnapshotStatus(state: OperationsWorkspaceState): SnapshotStatus {
  return state.snapshotStatus;
}

/** All queue items from the current snapshot, or empty if no snapshot. */
export function selectQueueItems(state: OperationsWorkspaceState): readonly WorkQueueItemView[] {
  return state.snapshot?.queue ?? EMPTY_QUEUE;
}

/**
 * Queue items filtered by the current status filter.
 * Returns all items when the filter is empty.
 */
export function selectFilteredQueueItems(
  state: OperationsWorkspaceState,
): readonly WorkQueueItemView[] {
  const items = selectQueueItems(state);
  const { statusFilter } = state.filters;

  if (statusFilter.length === 0) {
    return items;
  }

  const allowed = new Set(statusFilter);
  return items.filter((item) => allowed.has(item.status));
}

/** ID of the currently selected work item, or null. */
export function selectSelectedWorkItemId(state: OperationsWorkspaceState): string | null {
  return state.selection.selectedWorkItemId;
}

/** Loaded detail for the selected work item, or null. */
export function selectSelectedDetail(
  state: OperationsWorkspaceState,
): GetWorkItemDetailResponse | null {
  return state.selection.detail;
}

/** The active status filter. */
export function selectStatusFilter(state: OperationsWorkspaceState): readonly WorkItemStatus[] {
  return state.filters.statusFilter;
}

/** Current workspace data freshness. */
export function selectFreshness(state: OperationsWorkspaceState): WorkspaceFreshness {
  return state.freshness;
}

/** Current workspace availability. */
export function selectAvailability(state: OperationsWorkspaceState): WorkspaceAvailability {
  return state.availability;
}

/** Daemon health from the latest snapshot, or null. */
export function selectHealthStatus(state: OperationsWorkspaceState): DaemonHealthView | null {
  return state.snapshot?.health ?? null;
}

/** Whether a control action is pending for the given work item. */
export function selectHasPendingControl(
  state: OperationsWorkspaceState,
  workItemId: string,
): boolean {
  return state.controls.pendingByWorkItem.has(workItemId);
}

/** Controls from the currently selected item's detail, or empty. */
export function selectControlsForSelectedItem(
  state: OperationsWorkspaceState,
): readonly OperationalControlView[] {
  return state.selection.detail?.controls ?? EMPTY_CONTROLS;
}
