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
