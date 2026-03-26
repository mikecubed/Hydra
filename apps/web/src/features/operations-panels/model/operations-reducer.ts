/**
 * Pure reducer for the operations panels workspace state machine.
 *
 * Contains the initial-state factory, a discriminated-union action type,
 * and the top-level `reduceOperationsState` switch. Every function is a
 * pure (state, action) → state transform with no side effects.
 */

import type {
  BatchControlDiscoveryResponse,
  GetOperationsSnapshotResponse,
  GetWorkItemDetailResponse,
  PendingControlRequest,
  WorkItemStatus,
} from '@hydra/web-contracts';

import type { OperationsWorkspaceState } from './operations-types.ts';

// ─── Action types ───────────────────────────────────────────────────────────

export type OperationsAction =
  | { readonly type: 'snapshot/request' }
  | { readonly type: 'snapshot/success'; readonly snapshot: GetOperationsSnapshotResponse }
  | { readonly type: 'snapshot/failure' }
  | { readonly type: 'filters/set-status'; readonly statusFilter: readonly WorkItemStatus[] }
  | { readonly type: 'selection/select'; readonly workItemId: string }
  | { readonly type: 'selection/deselect' }
  | { readonly type: 'selection/detail-loading' }
  | { readonly type: 'selection/detail-loaded'; readonly detail: GetWorkItemDetailResponse }
  | { readonly type: 'selection/detail-failed' }
  | { readonly type: 'controls/submit-pending'; readonly pending: PendingControlRequest }
  | {
      readonly type: 'controls/submit-resolved';
      readonly workItemId: string;
    }
  | {
      readonly type: 'controls/discovery-loaded';
      readonly discovery: BatchControlDiscoveryResponse;
    };

// ─── Initial state factory ──────────────────────────────────────────────────

export function createInitialOperationsState(): OperationsWorkspaceState {
  return {
    snapshotStatus: 'idle',
    snapshot: null,
    freshness: 'stale',
    availability: 'empty',
    lastSynchronizedAt: null,
    filters: {
      statusFilter: [],
    },
    selection: {
      selectedWorkItemId: null,
      detail: null,
      detailAvailability: null,
      detailFetchStatus: 'idle',
    },
    controls: {
      pendingByWorkItem: new Map(),
      discovery: null,
    },
  };
}

/**
 * Route-mount initializer — starts as loading/refreshing so the first paint
 * reflects the pending snapshot fetch rather than briefly flashing idle state.
 */
export function createRouteInitialOperationsState(): OperationsWorkspaceState {
  return {
    ...createInitialOperationsState(),
    snapshotStatus: 'loading',
    freshness: 'refreshing',
  };
}

// ─── Per-action reducers ────────────────────────────────────────────────────

function reduceSnapshotRequest(state: OperationsWorkspaceState): OperationsWorkspaceState {
  return {
    ...state,
    snapshotStatus: 'loading',
    freshness: 'refreshing',
  };
}

function reduceSnapshotSuccess(
  state: OperationsWorkspaceState,
  snapshot: GetOperationsSnapshotResponse,
): OperationsWorkspaceState {
  const selectedWorkItemId = state.selection.selectedWorkItemId;
  let selection = state.selection;

  if (selectedWorkItemId !== null) {
    const selectedItem = snapshot.queue.find((item) => item.id === selectedWorkItemId) ?? null;

    selection =
      selectedItem === null
        ? {
            selectedWorkItemId: null,
            detail: null,
            detailAvailability: null,
            detailFetchStatus: 'idle' as const,
          }
        : {
            ...state.selection,
            detail:
              state.selection.detail == null
                ? null
                : {
                    ...state.selection.detail,
                    item: selectedItem,
                    availability: selectedItem.detailAvailability,
                  },
            detailAvailability: selectedItem.detailAvailability,
          };
  }

  return {
    ...state,
    snapshotStatus: 'ready',
    snapshot,
    freshness: 'live',
    availability: snapshot.availability,
    lastSynchronizedAt: snapshot.lastSynchronizedAt,
    selection,
  };
}

function reduceSnapshotFailure(state: OperationsWorkspaceState): OperationsWorkspaceState {
  return {
    ...state,
    snapshotStatus: 'error',
    freshness: 'stale',
  };
}

function reduceFiltersSetStatus(
  state: OperationsWorkspaceState,
  statusFilter: readonly WorkItemStatus[],
): OperationsWorkspaceState {
  return {
    ...state,
    filters: { ...state.filters, statusFilter },
  };
}

function reduceSelectionSelect(
  state: OperationsWorkspaceState,
  workItemId: string,
): OperationsWorkspaceState {
  if (state.selection.selectedWorkItemId === workItemId) {
    return state;
  }

  return {
    ...state,
    selection: {
      selectedWorkItemId: workItemId,
      detail: null,
      detailAvailability: null,
      detailFetchStatus: 'idle',
    },
  };
}

function reduceSelectionDeselect(state: OperationsWorkspaceState): OperationsWorkspaceState {
  if (state.selection.selectedWorkItemId === null) {
    return state;
  }

  return {
    ...state,
    selection: {
      selectedWorkItemId: null,
      detail: null,
      detailAvailability: null,
      detailFetchStatus: 'idle',
    },
  };
}

function reduceSelectionDetailLoading(state: OperationsWorkspaceState): OperationsWorkspaceState {
  if (state.selection.selectedWorkItemId === null) {
    return state;
  }

  return {
    ...state,
    selection: {
      ...state.selection,
      detailFetchStatus: 'loading',
    },
  };
}

function reduceSelectionDetailLoaded(
  state: OperationsWorkspaceState,
  detail: GetWorkItemDetailResponse,
): OperationsWorkspaceState {
  if (state.selection.selectedWorkItemId !== detail.item.id) {
    return state;
  }

  return {
    ...state,
    selection: {
      ...state.selection,
      detail,
      detailAvailability: detail.availability,
      detailFetchStatus: 'idle',
    },
  };
}

function reduceSelectionDetailFailed(state: OperationsWorkspaceState): OperationsWorkspaceState {
  if (state.selection.selectedWorkItemId === null) {
    return state;
  }

  return {
    ...state,
    selection: {
      ...state.selection,
      detailFetchStatus: 'error',
    },
  };
}

function reduceControlsSubmitPending(
  state: OperationsWorkspaceState,
  pending: PendingControlRequest,
): OperationsWorkspaceState {
  const next = new Map(state.controls.pendingByWorkItem);
  next.set(pending.workItemId, pending);

  return {
    ...state,
    controls: { ...state.controls, pendingByWorkItem: next },
  };
}

function reduceControlsSubmitResolved(
  state: OperationsWorkspaceState,
  workItemId: string,
): OperationsWorkspaceState {
  if (!state.controls.pendingByWorkItem.has(workItemId)) {
    return state;
  }

  const next = new Map(state.controls.pendingByWorkItem);
  next.delete(workItemId);

  return {
    ...state,
    controls: { ...state.controls, pendingByWorkItem: next },
  };
}

function reduceControlsDiscoveryLoaded(
  state: OperationsWorkspaceState,
  discovery: BatchControlDiscoveryResponse,
): OperationsWorkspaceState {
  return {
    ...state,
    controls: { ...state.controls, discovery },
  };
}

function assertNever(action: never): never {
  throw new Error(`Unhandled operations action: ${JSON.stringify(action)}`);
}

// ─── Top-level reducer ──────────────────────────────────────────────────────

export function reduceOperationsState(
  state: OperationsWorkspaceState,
  action: OperationsAction,
): OperationsWorkspaceState {
  switch (action.type) {
    case 'snapshot/request':
      return reduceSnapshotRequest(state);
    case 'snapshot/success':
      return reduceSnapshotSuccess(state, action.snapshot);
    case 'snapshot/failure':
      return reduceSnapshotFailure(state);
    case 'filters/set-status':
      return reduceFiltersSetStatus(state, action.statusFilter);
    case 'selection/select':
      return reduceSelectionSelect(state, action.workItemId);
    case 'selection/deselect':
      return reduceSelectionDeselect(state);
    case 'selection/detail-loading':
      return reduceSelectionDetailLoading(state);
    case 'selection/detail-loaded':
      return reduceSelectionDetailLoaded(state, action.detail);
    case 'selection/detail-failed':
      return reduceSelectionDetailFailed(state);
    case 'controls/submit-pending':
      return reduceControlsSubmitPending(state, action.pending);
    case 'controls/submit-resolved':
      return reduceControlsSubmitResolved(state, action.workItemId);
    case 'controls/discovery-loaded':
      return reduceControlsDiscoveryLoaded(state, action.discovery);
    default:
      return assertNever(action);
  }
}
