/**
 * Operations entities — browser-safe view DTOs for Hydra operations panels.
 *
 * These are daemon-authored projections of Hydra task/work state, checkpoint
 * history, routing/assignment decisions, health, budget posture, and control
 * affordances. The browser and gateway consume these shapes; neither invents
 * hidden status mappings.
 *
 * The operations queue is derived from daemon task/work state and is
 * intentionally distinct from the per-conversation instruction queue in
 * work-control contracts.
 */
import { z } from 'zod';

// ── Work Queue ───────────────────────────────────────────────────────────────

/** Normalized work-item status as seen by the operator. */
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

/** Risk badge surfaced alongside a work item. */
export const RiskBadge = z.object({
  kind: z.enum(['budget', 'health', 'stale', 'blocked', 'recovery']),
  label: z.string().min(1),
  severity: z.enum(['info', 'warning', 'critical']),
});
export type RiskBadge = z.infer<typeof RiskBadge>;

/** Daemon-authored projection of one visible unit of Hydra work. */
export const WorkQueueItemView = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: WorkItemStatus,
  ordering: z.number().int().nonnegative(),
  conversationId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  latestCheckpointSummary: z.string().optional(),
  riskBadges: z.array(RiskBadge),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type WorkQueueItemView = z.infer<typeof WorkQueueItemView>;

// ── Checkpoints ──────────────────────────────────────────────────────────────

/** Checkpoint status within its lifecycle. */
export const CheckpointStatus = z.enum(['pending', 'active', 'completed', 'skipped', 'failed']);
export type CheckpointStatus = z.infer<typeof CheckpointStatus>;

/** Ordered checkpoint history record for a work item. */
export const CheckpointRecordView = z.object({
  id: z.string().min(1),
  workItemId: z.string().min(1),
  position: z.number().int().nonnegative(),
  label: z.string().min(1),
  status: CheckpointStatus,
  timestamp: z.iso.datetime(),
  recoveryContext: z.string().optional(),
  waitingContext: z.string().optional(),
});
export type CheckpointRecordView = z.infer<typeof CheckpointRecordView>;

// ── Routing & Mode ───────────────────────────────────────────────────────────

/** A single routing or mode selection record. */
export const RoutingDecisionView = z.object({
  routeLabel: z.string().min(1),
  modeLabel: z.string().min(1),
  changedAt: z.iso.datetime(),
  provenance: z.string().optional(),
});
export type RoutingDecisionView = z.infer<typeof RoutingDecisionView>;

// ── Agent Assignment ─────────────────────────────────────────────────────────

/** Assignment state for an agent participant. */
export const AssignmentState = z.enum(['active', 'completed', 'yielded', 'replaced', 'failed']);
export type AssignmentState = z.infer<typeof AssignmentState>;

/** Current or historical contributor assignment for a work item. */
export const AgentAssignmentView = z.object({
  participantId: z.string().min(1),
  label: z.string().min(1),
  role: z.string().min(1),
  state: AssignmentState,
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().optional(),
});
export type AgentAssignmentView = z.infer<typeof AgentAssignmentView>;

// ── Council Execution ────────────────────────────────────────────────────────

/** Overall status of a council/multi-agent execution. */
export const CouncilOverallStatus = z.enum(['in-progress', 'completed', 'failed', 'cancelled']);
export type CouncilOverallStatus = z.infer<typeof CouncilOverallStatus>;

/** Stage summary within a council execution timeline. */
export const CouncilStageSummary = z.object({
  stageLabel: z.string().min(1),
  status: z.enum(['pending', 'active', 'completed', 'failed', 'skipped']),
  summary: z.string().optional(),
  timestamp: z.iso.datetime(),
});
export type CouncilStageSummary = z.infer<typeof CouncilStageSummary>;

/** Summary/timeline of multi-agent or council execution. */
export const CouncilExecutionView = z.object({
  participants: z.array(AgentAssignmentView),
  stages: z.array(CouncilStageSummary),
  overallStatus: CouncilOverallStatus,
  finalOutcome: z.string().optional(),
});
export type CouncilExecutionView = z.infer<typeof CouncilExecutionView>;

// ── Daemon Health ────────────────────────────────────────────────────────────

/** Daemon health condition as seen by the operator. */
export const HealthCondition = z.enum(['healthy', 'degraded', 'unavailable', 'recovering']);
export type HealthCondition = z.infer<typeof HealthCondition>;

/** Authoritative workspace-visible daemon health snapshot. */
export const DaemonHealthView = z.object({
  condition: HealthCondition,
  observedAt: z.iso.datetime(),
  scope: z.enum(['global', 'work-item']),
  recoveryMessage: z.string().optional(),
});
export type DaemonHealthView = z.infer<typeof DaemonHealthView>;

// ── Budget Status ────────────────────────────────────────────────────────────

/** Budget severity as presented to the operator. */
export const BudgetCondition = z.enum(['normal', 'warning', 'exceeded', 'unavailable']);
export type BudgetCondition = z.infer<typeof BudgetCondition>;

/** Authoritative budget posture for a given scope. */
export const BudgetStatusView = z.object({
  condition: BudgetCondition,
  scope: z.enum(['global', 'session', 'work-item']),
  currentUsage: z.string().optional(),
  limit: z.string().optional(),
  isComplete: z.boolean(),
});
export type BudgetStatusView = z.infer<typeof BudgetStatusView>;

// ── Operational Control ──────────────────────────────────────────────────────

/** The operator-facing availability of a control affordance. */
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

/** Category of operational control. */
export const ControlKind = z.enum(['routing', 'mode', 'agent', 'council']);
export type ControlKind = z.infer<typeof ControlKind>;

/** A selectable option within an operational control. */
export const ControlOption = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
});
export type ControlOption = z.infer<typeof ControlOption>;

/** Browser-facing control affordance with daemon-owned eligibility/result state. */
export const OperationalControlView = z.object({
  controlId: z.string().min(1),
  kind: ControlKind,
  label: z.string().min(1),
  availability: ControlAvailability,
  currentOptionId: z.string().min(1).optional(),
  options: z.array(ControlOption),
  expectedRevision: z.string().min(1).optional(),
  staleReason: z.string().optional(),
  resultMessage: z.string().optional(),
});
export type OperationalControlView = z.infer<typeof OperationalControlView>;

// ── Availability ─────────────────────────────────────────────────────────────

/** Explicit data availability — never encode empty vs partial vs unavailable with null alone. */
export const DataAvailability = z.enum(['ready', 'empty', 'partial', 'unavailable']);
export type DataAvailability = z.infer<typeof DataAvailability>;
