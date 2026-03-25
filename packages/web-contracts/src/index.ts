/**
 * @hydra/web-contracts — Shared cross-surface contracts for the Hydra web initiative.
 *
 * This barrel re-exports all published contracts and vocabulary definitions.
 * Later phases append new re-exports here as contracts are added.
 */

export {
  ConversationStub,
  TurnStub,
  StreamEventStub,
  ApprovalRequestStub,
  ArtifactStub,
  SessionSnapshotStub,
  CONTRACT_FAMILIES,
} from './vocabulary.ts';

export type { ConversationStub as ConversationType } from './vocabulary.ts';
export type { TurnStub as TurnType } from './vocabulary.ts';
export type { StreamEventStub as StreamEventType } from './vocabulary.ts';
export type { ApprovalRequestStub as ApprovalRequestType } from './vocabulary.ts';
export type { ArtifactStub as ArtifactType } from './vocabulary.ts';
export type { SessionSnapshotStub as SessionSnapshotType } from './vocabulary.ts';
export type { ContractFamily } from './vocabulary.ts';

// ─── Session & Auth contracts (Phase 1 — web-session-auth) ──────────────────

export {
  SessionState,
  TERMINAL_STATES,
  SessionInfo,
  SessionEvent,
  ExtendResponse,
} from './session-schemas.ts';

export { LoginRequest, LoginResponse, LogoutResponse, AuthError } from './auth-schemas.ts';

export { AuditEventType, AuditRecord } from './audit-schemas.ts';

export { Operator, CredentialType } from './operator-schemas.ts';

// ─── Conversation Protocol entities (Phase 2 — web-conversation-protocol) ───

export { Attribution, AttributionType } from './attribution.ts';
export { Conversation, ConversationStatus } from './conversation.ts';
export { Turn, TurnKind, TurnStatus } from './turn.ts';
export { StreamEvent, StreamEventKind } from './stream.ts';
export { ApprovalRequest, ApprovalStatus, ApprovalResponseOption } from './approval.ts';
export { Artifact, ArtifactKind } from './artifact.ts';
export { ActivityEntry, ActivityKind } from './activity.ts';

// ─── Conversation Protocol contracts ─────────────────────────────────────────

export {
  CreateConversationRequest,
  CreateConversationResponse,
  OpenConversationRequest,
  OpenConversationResponse,
  ResumeConversationRequest,
  ResumeConversationBody,
  ResumeConversationResponse,
  ArchiveConversationRequest,
  ArchiveConversationResponse,
  ListConversationsRequest,
  ListConversationsResponse,
} from './contracts/conversation-lifecycle.ts';

export {
  SubmitInstructionRequest,
  SubmitInstructionBody,
  SubmitInstructionResponse,
  SubscribeToStreamRequest,
  SubscribeToStreamResponse,
  LoadTurnHistoryRequest,
  LoadTurnHistoryResponse,
} from './contracts/turn-submission.ts';

export {
  GetPendingApprovalsRequest,
  GetPendingApprovalsResponse,
  RespondToApprovalRequest,
  RespondToApprovalResponse,
} from './contracts/approval-flow.ts';

export {
  CancelWorkRequest,
  CancelWorkResponse,
  RetryTurnRequest,
  RetryTurnResponse,
  ForkConversationRequest,
  ForkConversationResponse,
  QueuedInstruction,
  ManageQueueRequest,
  ManageQueueResponse,
} from './contracts/work-control.ts';

export {
  ListArtifactsForTurnRequest,
  ListArtifactsForTurnResponse,
  GetArtifactContentRequest,
  GetArtifactContentResponse,
  ListArtifactsForConversationRequest,
  ListArtifactsForConversationResponse,
} from './contracts/artifact-access.ts';

export {
  GetActivityEntriesRequest,
  GetActivityEntriesResponse,
  FilterActivityByAgentRequest,
  FilterActivityByAgentResponse,
} from './contracts/multi-agent-activity.ts';

export { ErrorCode, ErrorResponse } from './contracts/error.ts';

// ─── Operations Panels contracts (Phase 3 — web-hydra-operations-panels) ────

export {
  WorkItemStatus,
  DetailAvailability,
  RiskSignalKind,
  RiskSignalSeverity,
  RiskSignal,
  WorkQueueItemView,
  CheckpointStatus,
  CheckpointRecordView,
  DaemonHealthStatus,
  HealthDetailsAvailability,
  DaemonHealthView,
  BudgetSeverity,
  BudgetScope,
  BudgetStatusView,
  RoutingHistoryEntry,
  RoutingDecisionView,
  AgentAssignmentState,
  AgentAssignmentView,
  CouncilExecutionStatus,
  CouncilTransitionView,
  CouncilExecutionView,
  ControlKind,
  ControlAvailability,
  ControlAuthority,
  ControlOptionView,
  OperationalControlView,
  PendingControlRequest,
  SnapshotStatus,
  WorkspaceFreshness,
  WorkspaceAvailability,
} from './operations.ts';

export {
  GetOperationsSnapshotRequest,
  GetOperationsSnapshotResponse,
  GetWorkItemDetailRequest,
  GetWorkItemDetailResponse,
  GetWorkItemCheckpointsRequest,
  GetWorkItemCheckpointsResponse,
  GetWorkItemExecutionRequest,
  GetWorkItemExecutionResponse,
  GetWorkItemControlsRequest,
  GetWorkItemControlsResponse,
} from './contracts/operations-read.ts';

export {
  ControlOutcome,
  SubmitControlActionRequest,
  SubmitControlActionBody,
  SubmitControlActionResponse,
  BatchControlDiscoveryRequest,
  WorkItemControlEntry,
  BatchControlDiscoveryResponse,
} from './contracts/operations-control.ts';
