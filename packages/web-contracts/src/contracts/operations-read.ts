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
  WorkItemStatus,
  WorkQueueItemView,
  CheckpointRecordView,
  RoutingDecisionView,
  AgentAssignmentView,
  CouncilExecutionView,
  OperationalControlView,
  DaemonHealthView,
  BudgetStatusView,
  DetailAvailability,
  WorkspaceAvailability,
} from '../operations.ts';

const SnapshotStatusFilter = z.array(WorkItemStatus).readonly();

export const GetOperationsSnapshotRequest = z
  .object({
    statusFilter: SnapshotStatusFilter.optional(),
    limit: z.number().int().positive().optional(),
    cursor: z.string().min(1).optional(),
  })
  .strict();
export type GetOperationsSnapshotRequest = z.infer<typeof GetOperationsSnapshotRequest>;

export const GetOperationsSnapshotResponse = z
  .object({
    queue: z.array(WorkQueueItemView).readonly(),
    health: DaemonHealthView.nullable(),
    budget: BudgetStatusView.nullable(),
    availability: WorkspaceAvailability,
    lastSynchronizedAt: z.iso.datetime().nullable(),
    nextCursor: z.string().min(1).nullable(),
  })
  .strict();
export type GetOperationsSnapshotResponse = z.infer<typeof GetOperationsSnapshotResponse>;

export const GetWorkItemDetailRequest = z
  .object({
    workItemId: z.string().min(1),
  })
  .strict();
export type GetWorkItemDetailRequest = z.infer<typeof GetWorkItemDetailRequest>;

export const GetWorkItemDetailResponse = z
  .object({
    item: WorkQueueItemView,
    checkpoints: z.array(CheckpointRecordView).readonly(),
    routing: RoutingDecisionView.nullable(),
    assignments: z.array(AgentAssignmentView).readonly(),
    council: CouncilExecutionView.nullable(),
    controls: z.array(OperationalControlView).readonly(),
    itemBudget: BudgetStatusView.nullable(),
    availability: DetailAvailability,
  })
  .strict();
export type GetWorkItemDetailResponse = z.infer<typeof GetWorkItemDetailResponse>;

export const GetWorkItemCheckpointsRequest = z
  .object({
    workItemId: z.string().min(1),
  })
  .strict();
export type GetWorkItemCheckpointsRequest = z.infer<typeof GetWorkItemCheckpointsRequest>;

export const GetWorkItemCheckpointsResponse = z
  .object({
    workItemId: z.string().min(1),
    checkpoints: z.array(CheckpointRecordView).readonly(),
    availability: DetailAvailability,
  })
  .strict();
export type GetWorkItemCheckpointsResponse = z.infer<typeof GetWorkItemCheckpointsResponse>;

export const GetWorkItemExecutionRequest = z
  .object({
    workItemId: z.string().min(1),
  })
  .strict();
export type GetWorkItemExecutionRequest = z.infer<typeof GetWorkItemExecutionRequest>;

export const GetWorkItemExecutionResponse = z
  .object({
    workItemId: z.string().min(1),
    routing: RoutingDecisionView.nullable(),
    assignments: z.array(AgentAssignmentView).readonly(),
    council: CouncilExecutionView.nullable(),
    availability: DetailAvailability,
  })
  .strict();
export type GetWorkItemExecutionResponse = z.infer<typeof GetWorkItemExecutionResponse>;

export const GetWorkItemControlsRequest = z
  .object({
    workItemId: z.string().min(1),
  })
  .strict();
export type GetWorkItemControlsRequest = z.infer<typeof GetWorkItemControlsRequest>;

export const GetWorkItemControlsResponse = z
  .object({
    workItemId: z.string().min(1),
    controls: z.array(OperationalControlView).readonly(),
    availability: DetailAvailability,
  })
  .strict();
export type GetWorkItemControlsResponse = z.infer<typeof GetWorkItemControlsResponse>;
