/**
 * Operations entity schemas — shared browser-safe DTOs for the operations panels.
 *
 * These schemas define the daemon-authored projection of operational state that
 * the browser and gateway consume. The daemon owns normalization; the browser
 * renders these projections without inferring state from raw internals.
 *
 * See data-model.md in the operations-panels SDD bundle for the authoritative
 * entity definitions and normalization rules.
 */
import { z } from 'zod';

// ─── Work Queue Item ─────────────────────────────────────────────────────────

export const WorkItemStatus = z.enum([
  'waiting',
  'active',
  'paused',
  'blocked',
  'completed',
  'failed',
  'cancelled',
]);
export type WorkItemStatus = z.infer<typeof WorkItemStatus>;

export const DetailAvailability = z.enum(['ready', 'partial', 'unavailable']);
export type DetailAvailability = z.infer<typeof DetailAvailability>;

export const RiskSignalKind = z.enum(['budget', 'health', 'waiting', 'stale']);
export type RiskSignalKind = z.infer<typeof RiskSignalKind>;

export const RiskSignalSeverity = z.enum(['info', 'warning', 'critical']);
export type RiskSignalSeverity = z.infer<typeof RiskSignalSeverity>;

export const RiskSignal = z
  .object({
    kind: RiskSignalKind,
    severity: RiskSignalSeverity,
    summary: z.string().min(1),
    scope: z.string().min(1),
  })
  .strict();
export type RiskSignal = z.infer<typeof RiskSignal>;

export const WorkQueueItemView = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    status: WorkItemStatus,
    position: z.number().int().nonnegative().nullable(),
    relatedConversationId: z.string().min(1).nullable(),
    relatedSessionId: z.string().min(1).nullable(),
    ownerLabel: z.string().min(1).nullable(),
    lastCheckpointSummary: z.string().min(1).nullable(),
    updatedAt: z.iso.datetime(),
    riskSignals: z.array(RiskSignal).readonly(),
    detailAvailability: DetailAvailability,
  })
  .strict();
export type WorkQueueItemView = z.infer<typeof WorkQueueItemView>;

// ─── Checkpoint Record ───────────────────────────────────────────────────────

export const CheckpointStatus = z.enum(['reached', 'waiting', 'resumed', 'recovered', 'skipped']);
export type CheckpointStatus = z.infer<typeof CheckpointStatus>;

export const CheckpointRecordView = z
  .object({
    id: z.string().min(1),
    sequence: z.number().int().nonnegative(),
    label: z.string().min(1),
    status: CheckpointStatus,
    timestamp: z.iso.datetime(),
    detail: z.string().min(1).nullable(),
  })
  .strict();
export type CheckpointRecordView = z.infer<typeof CheckpointRecordView>;

// ─── Daemon Health ───────────────────────────────────────────────────────────

export const DaemonHealthStatus = z.enum(['healthy', 'degraded', 'unavailable', 'recovering']);
export type DaemonHealthStatus = z.infer<typeof DaemonHealthStatus>;

export const HealthDetailsAvailability = z.enum(['ready', 'partial', 'unavailable']);
export type HealthDetailsAvailability = z.infer<typeof HealthDetailsAvailability>;

export const DaemonHealthView = z
  .object({
    status: DaemonHealthStatus,
    scope: z.literal('global'),
    observedAt: z.iso.datetime(),
    message: z.string().min(1).nullable(),
    detailsAvailability: HealthDetailsAvailability,
  })
  .strict();
export type DaemonHealthView = z.infer<typeof DaemonHealthView>;

// ─── Budget Status ───────────────────────────────────────────────────────────

export const BudgetSeverity = z.enum(['normal', 'warning', 'exceeded', 'unavailable']);
export type BudgetSeverity = z.infer<typeof BudgetSeverity>;

export const BudgetScope = z.enum(['global', 'work-item', 'session']);
export type BudgetScope = z.infer<typeof BudgetScope>;

export const BudgetStatusView = z
  .object({
    status: BudgetSeverity,
    scope: BudgetScope,
    scopeId: z.string().min(1).nullable(),
    summary: z.string().min(1),
    used: z.number().nonnegative().nullable(),
    limit: z.number().nonnegative().nullable(),
    unit: z.string().min(1).nullable(),
    complete: z.boolean(),
  })
  .strict()
  .refine(
    (data) => {
      if (data.scope !== 'global') return data.scopeId !== null;
      return true;
    },
    { message: 'scopeId is required when scope is not global', path: ['scopeId'] },
  );
export type BudgetStatusView = z.infer<typeof BudgetStatusView>;

// ─── Routing Decision ────────────────────────────────────────────────────────

export const RoutingHistoryEntry = z
  .object({
    id: z.string().min(1),
    route: z.string().min(1).nullable(),
    mode: z.string().min(1).nullable(),
    changedAt: z.iso.datetime(),
    reason: z.string().min(1).nullable(),
  })
  .strict();
export type RoutingHistoryEntry = z.infer<typeof RoutingHistoryEntry>;

export const RoutingDecisionView = z
  .object({
    currentMode: z.string().min(1).nullable(),
    currentRoute: z.string().min(1).nullable(),
    changedAt: z.iso.datetime().nullable(),
    history: z.array(RoutingHistoryEntry).readonly(),
  })
  .strict();
export type RoutingDecisionView = z.infer<typeof RoutingDecisionView>;

// ─── Agent Assignment ────────────────────────────────────────────────────────

export const AgentAssignmentState = z.enum([
  'active',
  'waiting',
  'completed',
  'failed',
  'cancelled',
]);
export type AgentAssignmentState = z.infer<typeof AgentAssignmentState>;

export const AgentAssignmentView = z
  .object({
    participantId: z.string().min(1),
    label: z.string().min(1),
    role: z.string().min(1).nullable(),
    state: AgentAssignmentState,
    startedAt: z.iso.datetime().nullable(),
    endedAt: z.iso.datetime().nullable(),
  })
  .strict();
export type AgentAssignmentView = z.infer<typeof AgentAssignmentView>;

// ─── Council Execution ───────────────────────────────────────────────────────

export const CouncilExecutionStatus = z.enum([
  'active',
  'waiting',
  'completed',
  'failed',
  'cancelled',
]);
export type CouncilExecutionStatus = z.infer<typeof CouncilExecutionStatus>;

export const CouncilTransitionView = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    status: z.string().min(1),
    timestamp: z.iso.datetime(),
    detail: z.string().min(1).nullable(),
  })
  .strict();
export type CouncilTransitionView = z.infer<typeof CouncilTransitionView>;

export const CouncilExecutionView = z
  .object({
    status: CouncilExecutionStatus,
    participants: z.array(AgentAssignmentView).readonly(),
    transitions: z.array(CouncilTransitionView).readonly(),
    finalOutcome: z.string().min(1).nullable(),
  })
  .strict();
export type CouncilExecutionView = z.infer<typeof CouncilExecutionView>;

// ─── Operational Control ─────────────────────────────────────────────────────

export const ControlKind = z.enum(['routing', 'mode', 'agent', 'council']);
export type ControlKind = z.infer<typeof ControlKind>;

export const ControlAvailability = z.enum([
  'actionable',
  'pending',
  'read-only',
  'unavailable',
  'stale',
  'accepted',
  'rejected',
  'superseded',
]);
export type ControlAvailability = z.infer<typeof ControlAvailability>;

export const ControlAuthority = z.enum(['granted', 'forbidden', 'unavailable']);
export type ControlAuthority = z.infer<typeof ControlAuthority>;

export const ControlOptionView = z
  .object({
    optionId: z.string().min(1),
    label: z.string().min(1),
    selected: z.boolean(),
    available: z.boolean(),
  })
  .strict();
export type ControlOptionView = z.infer<typeof ControlOptionView>;

export const OperationalControlView = z
  .object({
    controlId: z.string().min(1),
    kind: ControlKind,
    label: z.string().min(1),
    availability: ControlAvailability,
    authority: ControlAuthority,
    reason: z.string().min(1).nullable(),
    options: z.array(ControlOptionView).readonly(),
    expectedRevision: z.string().min(1).nullable(),
    lastResolvedAt: z.iso.datetime().nullable(),
  })
  .superRefine((control, ctx) => {
    if (control.availability === 'actionable' && control.expectedRevision === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['expectedRevision'],
        message: 'Actionable controls require an expectedRevision token.',
      });
    }

    if (control.availability === 'actionable' && control.authority !== 'granted') {
      ctx.addIssue({
        code: 'custom',
        path: ['authority'],
        message: 'Actionable controls require granted authority.',
      });
    }
  })
  .strict();
export type OperationalControlView = z.infer<typeof OperationalControlView>;

// ─── Pending Control Request (browser-local) ─────────────────────────────────

export const PendingControlRequest = z
  .object({
    requestId: z.string().min(1),
    workItemId: z.string().min(1),
    controlId: z.string().min(1),
    submittedAt: z.iso.datetime(),
    requestedOptionId: z.string().min(1),
  })
  .strict();
export type PendingControlRequest = z.infer<typeof PendingControlRequest>;

// ─── Workspace-Level Availability & Freshness ────────────────────────────────

export const SnapshotStatus = z.enum(['idle', 'loading', 'ready', 'error']);
export type SnapshotStatus = z.infer<typeof SnapshotStatus>;

export const WorkspaceFreshness = z.enum(['live', 'refreshing', 'stale']);
export type WorkspaceFreshness = z.infer<typeof WorkspaceFreshness>;

export const WorkspaceAvailability = z.enum(['ready', 'empty', 'partial', 'unavailable']);
export type WorkspaceAvailability = z.infer<typeof WorkspaceAvailability>;
