/**
 * Derived selectors for the operations panels workspace.
 *
 * Each selector extracts a commonly-needed slice of OperationsWorkspaceState
 * so UI components never duplicate map-lookup / filter plumbing. All functions
 * are pure — no hidden state, no side effects.
 */

import type {
  AgentAssignmentView,
  BudgetStatusView,
  CheckpointRecordView,
  CouncilExecutionView,
  DaemonHealthView,
  DetailAvailability,
  OperationalControlView,
  RoutingDecisionView,
  SnapshotStatus,
  WorkItemStatus,
  WorkQueueItemView,
  WorkspaceAvailability,
  WorkspaceFreshness,
  GetWorkItemDetailResponse,
} from '@hydra/web-contracts';

import type { DetailFetchStatus, OperationsWorkspaceState } from './operations-types.ts';

const EMPTY_QUEUE: readonly WorkQueueItemView[] = [];
const EMPTY_CONTROLS: readonly OperationalControlView[] = [];
const EMPTY_CHECKPOINTS: readonly CheckpointRecordView[] = [];
const EMPTY_ASSIGNMENTS: readonly AgentAssignmentView[] = [];

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

/** Global budget posture from the latest snapshot, or null. */
export function selectBudgetStatus(state: OperationsWorkspaceState): BudgetStatusView | null {
  return state.snapshot?.budget ?? null;
}

/** Item-level budget from the currently selected item's detail, or null. */
export function selectItemBudget(state: OperationsWorkspaceState): BudgetStatusView | null {
  return state.selection.detail?.itemBudget ?? null;
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

/** Checkpoints from the currently selected item's detail, or empty. */
export function selectSelectedCheckpoints(
  state: OperationsWorkspaceState,
): readonly CheckpointRecordView[] {
  return state.selection.detail?.checkpoints ?? EMPTY_CHECKPOINTS;
}

/** Routing decision from the currently selected item's detail, or null. */
export function selectSelectedRouting(state: OperationsWorkspaceState): RoutingDecisionView | null {
  return state.selection.detail?.routing ?? null;
}

/** Agent assignments from the currently selected item's detail, or empty. */
export function selectSelectedAssignments(
  state: OperationsWorkspaceState,
): readonly AgentAssignmentView[] {
  return state.selection.detail?.assignments ?? EMPTY_ASSIGNMENTS;
}

/** Council execution from the currently selected item's detail, or null. */
export function selectSelectedCouncil(
  state: OperationsWorkspaceState,
): CouncilExecutionView | null {
  return state.selection.detail?.council ?? null;
}

/** Detail availability for the selected item, or null when no item is selected. */
export function selectDetailAvailability(
  state: OperationsWorkspaceState,
): DetailAvailability | null {
  return state.selection.detailAvailability;
}

/** Whether a detail response has been loaded for the selected item. */
export function selectHasDetail(state: OperationsWorkspaceState): boolean {
  return state.selection.detail !== null;
}

/** Fetch status for the selected item's detail request. */
export function selectDetailFetchStatus(state: OperationsWorkspaceState): DetailFetchStatus {
  return state.selection.detailFetchStatus;
}

/** Count of agent assignments in the selected work item's detail, or 0. */
export function selectSelectedAssignmentCount(state: OperationsWorkspaceState): number {
  return state.selection.detail?.assignments.length ?? 0;
}

/** Count of council transitions in the selected work item's detail, or 0. */
export function selectCouncilTransitionCount(state: OperationsWorkspaceState): number {
  return state.selection.detail?.council?.transitions.length ?? 0;
}
