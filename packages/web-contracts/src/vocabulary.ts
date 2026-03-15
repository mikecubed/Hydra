/**
 * Core protocol object vocabulary and daemon contract family index.
 *
 * Defines the six core protocol objects and five daemon contract families
 * at a definitional level. Full field-level schemas are deferred to later specs.
 *
 * See docs/web-interface/04-protocol.md for the authoritative protocol object definitions.
 * See docs/web-interface/06-phases-and-sdd.md Phase 0 for scope.
 */
import { z } from 'zod';

// ─── Core Protocol Object Stubs ─────────────────────────────────────────────
// Each stub uses a `kind` literal discriminator for future union discrimination.

export const ConversationStub = z.object({ kind: z.literal('conversation') });
export type ConversationStub = z.infer<typeof ConversationStub>;

export const TurnStub = z.object({ kind: z.literal('turn') });
export type TurnStub = z.infer<typeof TurnStub>;

export const StreamEventStub = z.object({ kind: z.literal('stream-event') });
export type StreamEventStub = z.infer<typeof StreamEventStub>;

export const ApprovalRequestStub = z.object({ kind: z.literal('approval-request') });
export type ApprovalRequestStub = z.infer<typeof ApprovalRequestStub>;

export const ArtifactStub = z.object({ kind: z.literal('artifact') });
export type ArtifactStub = z.infer<typeof ArtifactStub>;

export const SessionSnapshotStub = z.object({ kind: z.literal('session-snapshot') });
export type SessionSnapshotStub = z.infer<typeof SessionSnapshotStub>;

// ─── Contract Family Registry ────────────────────────────────────────────────
// Definitional index of the first five daemon contract families.
// The sixth family (operational intelligence) is deferred to a later phase.

export interface ContractFamily {
  readonly name: string;
  readonly purpose: string;
  readonly status: 'planned' | 'draft' | 'stable' | 'deprecated';
}

export const CONTRACT_FAMILIES: readonly ContractFamily[] = [
  {
    name: 'conversation-messaging',
    purpose: 'Create, open, resume conversations; submit turns; stream events',
    status: 'planned',
  },
  {
    name: 'command-catalog-and-execution',
    purpose: 'Discover and execute Hydra commands through typed contracts',
    status: 'planned',
  },
  {
    name: 'council-and-multi-agent-eventing',
    purpose: 'Structured events for multi-agent phase transitions, votes, reasoning',
    status: 'planned',
  },
  {
    name: 'task-live-output',
    purpose: 'Stream task progress, checkpoints, and live output',
    status: 'planned',
  },
  {
    name: 'config-and-controlled-mutations',
    purpose: 'Read masked config; write allowlisted settings through audited endpoints',
    status: 'planned',
  },
] as const;
