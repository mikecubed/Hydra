/**
 * Domain types for the chat workspace model.
 *
 * Extracted from workspace-store.ts — pure type definitions with no runtime
 * behaviour. All workspace modules and downstream consumers import types from
 * here (or via the workspace-store barrel re-export).
 */

import type { WorkspaceConnectionState } from '../../../shared/session-state.ts';

// ─── Scalar type aliases ────────────────────────────────────────────────────

export type ConversationLoadState = 'idle' | 'loading' | 'ready' | 'error';
export type DraftSubmitState = 'idle' | 'submitting' | 'error';
export type ArtifactAvailability = 'listed' | 'loading' | 'ready' | 'unavailable' | 'error';
export type TranscriptEntryKind = 'turn' | 'prompt' | 'activity-group' | 'system-status';
export type ContentBlockKind = 'text' | 'code' | 'status' | 'structured';
export type LineageRelationshipKind = 'follow-up' | 'retry' | 'branch' | null;
export type EntryControlKind = 'submit-follow-up' | 'cancel' | 'retry' | 'branch' | 'respond';
export type ConversationStatus = 'active' | 'archived';
export type PromptStatus =
  | 'pending'
  | 'responding'
  | 'resolved'
  | 'stale'
  | 'unavailable'
  | 'error';

// ─── Record & view-state interfaces ─────────────────────────────────────────

export interface WorkspaceConversationRecord {
  readonly id: string;
  readonly title?: string;
  readonly status?: ConversationStatus;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly turnCount?: number;
  readonly pendingInstructionCount?: number;
  readonly parentConversationId?: string;
  readonly forkPointTurnId?: string;
}

export interface ContentBlockState {
  readonly blockId: string;
  readonly kind: ContentBlockKind;
  readonly text: string | null;
  readonly metadata: Readonly<Record<string, string>> | null;
}

export interface ArtifactReferenceState {
  readonly artifactId: string;
  readonly kind: string;
  readonly label: string;
  readonly availability: ArtifactAvailability;
}

export interface EntryControlState {
  readonly controlId: string;
  readonly kind: EntryControlKind;
  readonly enabled: boolean;
  readonly reasonDisabled: string | null;
}

/**
 * Browser-side prompt view state for approval or follow-up requests.
 *
 * Stream events provide the `promptId` and optional metadata (allowed
 * responses, explanatory context). Full prompt details may be hydrated
 * later from the REST approval-flow contract via the `prompt/hydrate`
 * action. The lifecycle is:
 *
 *   pending → responding → resolved  (happy path)
 *   pending → stale                   (turn ended while prompt was pending)
 *   responding → error                (response submission failed)
 *   responding → stale                (turn ended while response in-flight)
 *   any → unavailable                 (server marks prompt as no longer valid)
 */
export interface PromptViewState {
  readonly promptId: string;
  readonly parentTurnId: string;
  readonly status: PromptStatus;
  readonly allowedResponses: readonly PromptResponseChoiceState[];
  readonly contextBlocks: readonly ContentBlockState[];
  readonly lastResponseSummary: string | null;
  readonly errorMessage: string | null;
  readonly staleReason: string | null;
}

export interface PromptResponseOptionState {
  readonly key: string;
  readonly label: string;
}

export type PromptResponseChoiceState = PromptResponseOptionState | string;

export interface TranscriptEntryState {
  readonly entryId: string;
  readonly kind: TranscriptEntryKind;
  readonly turnId: string | null;
  readonly attributionLabel?: string | null;
  readonly status: string;
  readonly timestamp: string | null;
  readonly contentBlocks: readonly ContentBlockState[];
  readonly artifacts: readonly ArtifactReferenceState[];
  readonly controls: readonly EntryControlState[];
  readonly prompt: PromptViewState | null;
}

export interface ConversationLineageState {
  readonly sourceConversationId: string | null;
  readonly sourceTurnId: string | null;
  readonly relationshipKind: LineageRelationshipKind;
}

export interface ConversationControlState {
  readonly canSubmit: boolean;
  readonly submissionPolicyLabel: string;
  readonly staleReason: string | null;
}

export interface ConversationViewState {
  readonly conversationId: string;
  readonly title: string;
  readonly status: ConversationStatus;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly turnCount: number;
  readonly pendingInstructionCount: number;
  readonly lineageSummary: ConversationLineageState | null;
  readonly entries: readonly TranscriptEntryState[];
  readonly hasMoreHistory: boolean;
  readonly loadState: ConversationLoadState;
  /**
   * Whether authoritative REST history has been loaded for this conversation.
   * Distinct from `loadState === 'ready'` — stream events can flip loadState
   * to 'ready' before history arrives. The transcript loader checks this flag
   * to decide whether to fetch/merge history, avoiding the race where stream
   * events cause the REST load to be skipped entirely.
   */
  readonly historyLoaded: boolean;
  readonly controlState: ConversationControlState;
}

export interface ComposerDraftState {
  readonly conversationId: string;
  readonly draftText: string;
  readonly submitState: DraftSubmitState;
  readonly validationMessage: string | null;
}

export interface ArtifactViewState {
  readonly artifactId: string;
  readonly turnId: string;
  readonly kind: string;
  readonly label: string;
  readonly availability: ArtifactAvailability;
  readonly previewBlocks: readonly ContentBlockState[];
}

export interface WorkspaceState {
  readonly activeConversationId: string | null;
  readonly explicitCreateMode: boolean;
  readonly conversationOrder: readonly string[];
  readonly conversations: ReadonlyMap<string, ConversationViewState>;
  readonly drafts: ReadonlyMap<string, ComposerDraftState>;
  readonly connection: WorkspaceConnectionState;
  readonly visibleArtifact: ArtifactViewState | null;
}

// ─── Action & store interfaces ──────────────────────────────────────────────

export type WorkspaceAction =
  | { readonly type: 'conversation/upsert'; readonly conversation: WorkspaceConversationRecord }
  | {
      readonly type: 'conversation/replace-all';
      readonly conversations: readonly WorkspaceConversationRecord[];
    }
  | { readonly type: 'conversation/select'; readonly conversationId: string | null }
  | {
      readonly type: 'conversation/set-load-state';
      readonly conversationId: string;
      readonly loadState: ConversationLoadState;
    }
  | {
      readonly type: 'conversation/replace-entries';
      readonly conversationId: string;
      readonly entries: readonly TranscriptEntryState[];
      readonly hasMoreHistory: boolean;
    }
  | {
      readonly type: 'draft/set-text';
      readonly conversationId: string;
      readonly draftText: string;
    }
  | {
      readonly type: 'draft/set-submit-state';
      readonly conversationId: string;
      readonly submitState: DraftSubmitState;
      readonly validationMessage: string | null;
    }
  | {
      readonly type: 'conversation/merge-history';
      readonly conversationId: string;
      readonly entries: readonly TranscriptEntryState[];
      readonly hasMoreHistory: boolean;
    }
  | {
      readonly type: 'conversation/append-submit-turn';
      readonly conversationId: string;
      readonly entry: TranscriptEntryState;
    }
  | {
      readonly type: 'connection/merge';
      readonly patch: Readonly<Partial<WorkspaceConnectionState>>;
    }
  | { readonly type: 'artifact/show'; readonly artifact: ArtifactViewState }
  | { readonly type: 'artifact/clear' }
  | {
      readonly type: 'prompt/begin-response';
      readonly conversationId: string;
      readonly turnId: string;
      readonly promptId: string;
    }
  | {
      readonly type: 'prompt/response-confirmed';
      readonly conversationId: string;
      readonly turnId: string;
      readonly promptId: string;
      readonly responseSummary: string | null;
    }
  | {
      readonly type: 'prompt/response-failed';
      readonly conversationId: string;
      readonly turnId: string;
      readonly promptId: string;
      readonly errorMessage: string | null;
    }
  | {
      readonly type: 'prompt/mark-stale';
      readonly conversationId: string;
      readonly turnId: string;
      readonly promptId: string;
      readonly reason: string | null;
    }
  | {
      readonly type: 'prompt/mark-unavailable';
      readonly conversationId: string;
      readonly turnId: string;
      readonly promptId: string;
    }
  | {
      readonly type: 'prompt/hydrate';
      readonly conversationId: string;
      readonly turnId: string;
      readonly promptId: string;
      readonly allowedResponses: readonly PromptResponseChoiceState[];
      readonly contextBlocks: readonly ContentBlockState[];
    }
  | {
      readonly type: 'conversation/update-control-state';
      readonly conversationId: string;
      readonly patch: Readonly<Partial<ConversationControlState>>;
    }
  | {
      readonly type: 'entry/update-controls';
      readonly conversationId: string;
      readonly entryId: string;
      readonly controls: readonly EntryControlState[];
    };

export type WorkspaceListener = (state: WorkspaceState, action: WorkspaceAction) => void;

export interface WorkspaceStore {
  getState(): WorkspaceState;
  dispatch(action: WorkspaceAction): void;
  subscribe(listener: WorkspaceListener): () => void;
}
