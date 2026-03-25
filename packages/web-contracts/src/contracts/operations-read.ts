/**
 * Operations Read contracts — snapshot and detail queries for the operations panels.
 *
 * These contracts define the request/response shapes for REST snapshot/detail
 * endpoints that the gateway exposes and the browser consumes. The daemon is the
 * source of truth; the gateway validates and mediates.
 *
 * Transport: REST polling with targeted refetch after control actions.
 * No new WebSocket family is introduced in this slice.
 */
import { z } from 'zod';
import {
  WorkQueueItemView,
  CheckpointRecordView,
  RoutingDecisionView,
  AgentAssignmentView,
  CouncilExecutionView,
  OperationalControlView,
  DaemonHealthView,
  BudgetStatusView,
  DataAvailability,
} from '../operations.ts';

// ── GetOperationsSnapshot ────────────────────────────────────────────────────
//
// Gateway route: GET /operations/snapshot
// Returns the top-level operations surface for the workspace: queue overview,
// daemon health, budget posture, and explicit availability.

export const GetOperationsSnapshotRequest = z.object({
  /** Optional status filter for the work queue. */
  statusFilter: z
    .array(z.enum(['waiting', 'active', 'paused', 'blocked', 'completed', 'failed', 'cancelled']))
    .optional(),
  /** Maximum number of queue items to return (pagination). */
  limit: z.number().int().positive().optional(),
  /** Opaque cursor for keyset pagination. */
  cursor: z.string().min(1).optional(),
});
export type GetOperationsSnapshotRequest = z.infer<typeof GetOperationsSnapshotRequest>;

export const GetOperationsSnapshotResponse = z.object({
  queue: z.array(WorkQueueItemView),
  health: DaemonHealthView.nullable(),
  budget: BudgetStatusView.nullable(),
  availability: DataAvailability,
  lastSynchronizedAt: z.iso.datetime().nullable(),
  nextCursor: z.string().min(1).optional(),
});
export type GetOperationsSnapshotResponse = z.infer<typeof GetOperationsSnapshotResponse>;

// ── GetWorkItemDetail ────────────────────────────────────────────────────────
//
// Gateway route: GET /operations/work-items/:workItemId
// Returns full detail for a selected work item: checkpoints, routing history,
// agent assignments, council execution, controls, and item-level budget.

export const GetWorkItemDetailRequest = z.object({
  workItemId: z.string().min(1),
});
export type GetWorkItemDetailRequest = z.infer<typeof GetWorkItemDetailRequest>;

export const GetWorkItemDetailResponse = z.object({
  item: WorkQueueItemView,
  checkpoints: z.array(CheckpointRecordView),
  routing: RoutingDecisionView.nullable(),
  routingHistory: z.array(RoutingDecisionView),
  assignments: z.array(AgentAssignmentView),
  council: CouncilExecutionView.nullable(),
  controls: z.array(OperationalControlView),
  itemBudget: BudgetStatusView.nullable(),
  availability: DataAvailability,
});
export type GetWorkItemDetailResponse = z.infer<typeof GetWorkItemDetailResponse>;

// ── GetWorkItemCheckpoints ───────────────────────────────────────────────────
//
// Optional focused route: GET /operations/work-items/:workItemId/checkpoints
// Exists if the combined detail payload grows too large.

export const GetWorkItemCheckpointsRequest = z.object({
  workItemId: z.string().min(1),
});
export type GetWorkItemCheckpointsRequest = z.infer<typeof GetWorkItemCheckpointsRequest>;

export const GetWorkItemCheckpointsResponse = z.object({
  workItemId: z.string().min(1),
  checkpoints: z.array(CheckpointRecordView),
  availability: DataAvailability,
});
export type GetWorkItemCheckpointsResponse = z.infer<typeof GetWorkItemCheckpointsResponse>;

// ── GetWorkItemExecution ─────────────────────────────────────────────────────
//
// Optional focused route: GET /operations/work-items/:workItemId/execution
// Routing, assignments, and council execution for a work item.

export const GetWorkItemExecutionRequest = z.object({
  workItemId: z.string().min(1),
});
export type GetWorkItemExecutionRequest = z.infer<typeof GetWorkItemExecutionRequest>;

export const GetWorkItemExecutionResponse = z.object({
  workItemId: z.string().min(1),
  routing: RoutingDecisionView.nullable(),
  routingHistory: z.array(RoutingDecisionView),
  assignments: z.array(AgentAssignmentView),
  council: CouncilExecutionView.nullable(),
  availability: DataAvailability,
});
export type GetWorkItemExecutionResponse = z.infer<typeof GetWorkItemExecutionResponse>;

// ── GetWorkItemControls ──────────────────────────────────────────────────────
//
// Optional focused route: GET /operations/work-items/:workItemId/controls
// Control discovery and current eligibility/state for a work item.

export const GetWorkItemControlsRequest = z.object({
  workItemId: z.string().min(1),
});
export type GetWorkItemControlsRequest = z.infer<typeof GetWorkItemControlsRequest>;

export const GetWorkItemControlsResponse = z.object({
  workItemId: z.string().min(1),
  controls: z.array(OperationalControlView),
  availability: DataAvailability,
});
export type GetWorkItemControlsResponse = z.infer<typeof GetWorkItemControlsResponse>;
