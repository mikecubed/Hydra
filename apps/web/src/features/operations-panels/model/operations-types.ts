/**
 * Domain types for the operations panels model.
 *
 * Phase 0 defines the browser-owned state shell that later phases populate with
 * snapshot polling, detail hydration, and control lifecycle orchestration.
 */
import type {
  BatchControlDiscoveryResponse,
  DetailAvailability,
  GetOperationsSnapshotResponse,
  GetWorkItemDetailResponse,
  PendingControlRequest,
  SnapshotStatus,
  WorkItemStatus,
  WorkspaceAvailability,
  WorkspaceFreshness,
} from '@hydra/web-contracts';

export interface OperationsFiltersState {
  readonly statusFilter: readonly WorkItemStatus[];
}

export interface OperationsSelectionState {
  readonly selectedWorkItemId: string | null;
  readonly detail: GetWorkItemDetailResponse | null;
  readonly detailAvailability: DetailAvailability | null;
}

export interface OperationsControlState {
  readonly pendingByWorkItem: ReadonlyMap<string, PendingControlRequest>;
  readonly discovery: BatchControlDiscoveryResponse | null;
}

export interface OperationsWorkspaceState {
  readonly snapshotStatus: SnapshotStatus;
  readonly snapshot: GetOperationsSnapshotResponse | null;
  readonly freshness: WorkspaceFreshness;
  readonly availability: WorkspaceAvailability;
  readonly lastSynchronizedAt: string | null;
  readonly filters: OperationsFiltersState;
  readonly selection: OperationsSelectionState;
  readonly controls: OperationsControlState;
}
