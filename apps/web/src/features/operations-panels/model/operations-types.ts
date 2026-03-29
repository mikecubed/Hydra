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

export type DetailFetchStatus = 'idle' | 'loading' | 'error';

export interface OperationsFiltersState {
  readonly statusFilter: readonly WorkItemStatus[];
}

export interface OperationsSelectionState {
  readonly selectedWorkItemId: string | null;
  readonly detail: GetWorkItemDetailResponse | null;
  readonly detailAvailability: DetailAvailability | null;
  readonly detailFetchStatus: DetailFetchStatus;
}

export interface OperationsControlState {
  readonly pendingByWorkItem: ReadonlyMap<string, PendingControlRequest>;
  readonly discovery: BatchControlDiscoveryResponse | null;
}

export interface OperationsWorkspaceState {
  readonly snapshotStatus: SnapshotStatus;
  readonly snapshot: GetOperationsSnapshotResponse | null;
  /** Error message from the most recent snapshot fetch failure (FD-5 async degraded state). */
  readonly snapshotErrorMessage: string | null;
  readonly freshness: WorkspaceFreshness;
  readonly availability: WorkspaceAvailability;
  readonly lastSynchronizedAt: string | null;
  readonly filters: OperationsFiltersState;
  readonly selection: OperationsSelectionState;
  readonly controls: OperationsControlState;
}
