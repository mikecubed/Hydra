import {
  initialConnectionState,
  type WorkspaceConnectionState,
} from '../../../shared/session-state.ts';

export type ConversationLoadState = 'idle' | 'loading' | 'ready' | 'error';
export type DraftSubmitState = 'idle' | 'submitting' | 'error';
export type ArtifactAvailability = 'listed' | 'loading' | 'ready' | 'unavailable' | 'error';
export type TranscriptEntryKind = 'turn' | 'prompt' | 'activity-group' | 'system-status';
export type ContentBlockKind = 'text' | 'code' | 'status' | 'structured';
export type LineageRelationshipKind = 'follow-up' | 'retry' | 'branch' | null;
export type EntryControlKind = 'submit-follow-up' | 'cancel' | 'retry' | 'branch' | 'respond';

export interface WorkspaceConversationRecord {
  readonly id: string;
  readonly title?: string;
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

export interface PromptViewState {
  readonly promptId: string;
  readonly parentTurnId: string;
  readonly status: 'pending' | 'responding' | 'resolved' | 'stale' | 'unavailable' | 'error';
  readonly allowedResponses: readonly string[];
  readonly contextBlocks: readonly ContentBlockState[];
  readonly lastResponseSummary: string | null;
}

export interface TranscriptEntryState {
  readonly entryId: string;
  readonly kind: TranscriptEntryKind;
  readonly turnId: string | null;
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
  readonly lineageSummary: ConversationLineageState | null;
  readonly entries: readonly TranscriptEntryState[];
  readonly hasMoreHistory: boolean;
  readonly loadState: ConversationLoadState;
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
  readonly conversationOrder: readonly string[];
  readonly conversations: ReadonlyMap<string, ConversationViewState>;
  readonly drafts: ReadonlyMap<string, ComposerDraftState>;
  readonly connection: WorkspaceConnectionState;
  readonly visibleArtifact: ArtifactViewState | null;
}

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
      readonly type: 'connection/merge';
      readonly patch: Readonly<Partial<WorkspaceConnectionState>>;
    }
  | { readonly type: 'artifact/show'; readonly artifact: ArtifactViewState }
  | { readonly type: 'artifact/clear' };

export type WorkspaceListener = (state: WorkspaceState, action: WorkspaceAction) => void;

export interface WorkspaceStore {
  getState(): WorkspaceState;
  dispatch(action: WorkspaceAction): void;
  subscribe(listener: WorkspaceListener): () => void;
}

const DEFAULT_SUBMISSION_POLICY_LABEL = 'Ready for operator input';

function createConversationLineage(
  conversation: WorkspaceConversationRecord,
): ConversationLineageState | null {
  if (conversation.parentConversationId == null || conversation.forkPointTurnId == null) {
    return null;
  }

  return {
    sourceConversationId: conversation.parentConversationId,
    sourceTurnId: conversation.forkPointTurnId,
    relationshipKind: 'branch',
  };
}

function createConversationViewState(
  conversation: WorkspaceConversationRecord,
): ConversationViewState {
  return {
    conversationId: conversation.id,
    title: conversation.title ?? 'Untitled conversation',
    lineageSummary: createConversationLineage(conversation),
    entries: [],
    hasMoreHistory: false,
    loadState: 'idle',
    controlState: {
      canSubmit: true,
      submissionPolicyLabel: DEFAULT_SUBMISSION_POLICY_LABEL,
      staleReason: null,
    },
  };
}

function createDraftState(conversationId: string): ComposerDraftState {
  return {
    conversationId,
    draftText: '',
    submitState: 'idle',
    validationMessage: null,
  };
}

function ensureConversation(
  conversations: ReadonlyMap<string, ConversationViewState>,
  conversationId: string,
): ConversationViewState {
  return conversations.get(conversationId) ?? createConversationViewState({ id: conversationId });
}

function ensureDraft(
  drafts: ReadonlyMap<string, ComposerDraftState>,
  conversationId: string,
): ComposerDraftState {
  return drafts.get(conversationId) ?? createDraftState(conversationId);
}

function withDraft(
  drafts: ReadonlyMap<string, ComposerDraftState>,
  conversationId: string,
): Map<string, ComposerDraftState> {
  const nextDrafts = new Map(drafts);
  nextDrafts.set(conversationId, ensureDraft(nextDrafts, conversationId));
  return nextDrafts;
}

function withConversationInOrder(
  conversationOrder: readonly string[],
  conversationId: string,
): readonly string[] {
  return conversationOrder.includes(conversationId)
    ? conversationOrder
    : [...conversationOrder, conversationId];
}

function pruneDrafts(
  drafts: ReadonlyMap<string, ComposerDraftState>,
  retainedConversationIds: ReadonlySet<string>,
): Map<string, ComposerDraftState> {
  const nextDrafts = new Map<string, ComposerDraftState>();

  for (const [conversationId, draft] of drafts) {
    if (retainedConversationIds.has(conversationId)) {
      nextDrafts.set(conversationId, draft);
    }
  }

  return nextDrafts;
}

export function createInitialWorkspaceState(): WorkspaceState {
  return {
    activeConversationId: null,
    conversationOrder: [],
    conversations: new Map(),
    drafts: new Map(),
    connection: initialConnectionState(),
    visibleArtifact: null,
  };
}

function mergeConversationView(
  previous: ConversationViewState | undefined,
  conversation: WorkspaceConversationRecord,
): ConversationViewState {
  return {
    ...(previous ?? createConversationViewState(conversation)),
    conversationId: conversation.id,
    title: conversation.title ?? previous?.title ?? 'Untitled conversation',
    lineageSummary: createConversationLineage(conversation) ?? previous?.lineageSummary ?? null,
  };
}

function applyConversationUpsert(
  state: WorkspaceState,
  conversation: WorkspaceConversationRecord,
): WorkspaceState {
  const nextConversations = new Map(state.conversations);
  const previous = nextConversations.get(conversation.id);
  nextConversations.set(conversation.id, mergeConversationView(previous, conversation));

  return {
    ...state,
    conversations: nextConversations,
    conversationOrder: state.conversationOrder.includes(conversation.id)
      ? state.conversationOrder
      : [...state.conversationOrder, conversation.id],
  };
}

function applyReplaceAllConversations(
  state: WorkspaceState,
  conversations: readonly WorkspaceConversationRecord[],
): WorkspaceState {
  const nextConversations = new Map<string, ConversationViewState>();
  const nextOrder: string[] = [];

  for (const conversation of conversations) {
    nextConversations.set(
      conversation.id,
      mergeConversationView(state.conversations.get(conversation.id), conversation),
    );
    nextOrder.push(conversation.id);
  }

  const fallbackId: string | null = nextOrder.length > 0 ? nextOrder[0] : null;
  const nextActiveConversationId =
    state.activeConversationId != null && nextConversations.has(state.activeConversationId)
      ? state.activeConversationId
      : fallbackId;
  const retainedConversationIds = new Set(nextOrder);
  const nextDraftsBase = pruneDrafts(state.drafts, retainedConversationIds);
  const nextDrafts =
    nextActiveConversationId == null
      ? nextDraftsBase
      : withDraft(nextDraftsBase, nextActiveConversationId);

  return {
    ...state,
    activeConversationId: nextActiveConversationId,
    conversationOrder: nextOrder,
    conversations: nextConversations,
    drafts: nextDrafts,
    visibleArtifact:
      nextActiveConversationId === state.activeConversationId ? state.visibleArtifact : null,
  };
}

function applyConversationSelection(
  state: WorkspaceState,
  conversationId: string | null,
): WorkspaceState {
  if (conversationId == null) {
    return { ...state, activeConversationId: null, visibleArtifact: null };
  }

  const nextConversations = new Map(state.conversations);
  if (!nextConversations.has(conversationId)) {
    nextConversations.set(conversationId, createConversationViewState({ id: conversationId }));
  }

  const nextDrafts = withDraft(state.drafts, conversationId);

  return {
    ...state,
    activeConversationId: conversationId,
    conversationOrder: withConversationInOrder(state.conversationOrder, conversationId),
    conversations: nextConversations,
    drafts: nextDrafts,
    visibleArtifact: conversationId === state.activeConversationId ? state.visibleArtifact : null,
  };
}

function applyConversationLoadState(
  state: WorkspaceState,
  conversationId: string,
  loadState: ConversationLoadState,
): WorkspaceState {
  const current = ensureConversation(state.conversations, conversationId);
  const nextConversations = new Map(state.conversations);
  nextConversations.set(conversationId, { ...current, loadState });
  return {
    ...state,
    conversationOrder: withConversationInOrder(state.conversationOrder, conversationId),
    conversations: nextConversations,
  };
}

function applyConversationEntries(
  state: WorkspaceState,
  conversationId: string,
  entries: readonly TranscriptEntryState[],
  hasMoreHistory: boolean,
): WorkspaceState {
  const current = ensureConversation(state.conversations, conversationId);
  const nextConversations = new Map(state.conversations);
  nextConversations.set(conversationId, {
    ...current,
    entries: [...entries],
    hasMoreHistory,
    loadState: 'ready',
  });
  return {
    ...state,
    conversationOrder: withConversationInOrder(state.conversationOrder, conversationId),
    conversations: nextConversations,
  };
}

function applyDraftText(
  state: WorkspaceState,
  conversationId: string,
  draftText: string,
): WorkspaceState {
  const nextDrafts = withDraft(state.drafts, conversationId);
  const current = ensureDraft(nextDrafts, conversationId);
  const nextText = draftText;
  const hasMeaningfulEdit = nextText !== current.draftText;
  const shouldClearError =
    current.submitState === 'error' && (hasMeaningfulEdit || nextText.trim() === '');
  nextDrafts.set(conversationId, {
    ...current,
    draftText: nextText,
    submitState: shouldClearError ? 'idle' : current.submitState,
    validationMessage:
      nextText.trim() === '' || shouldClearError ? null : current.validationMessage,
  });
  return { ...state, drafts: nextDrafts };
}

function applyDraftSubmitState(
  state: WorkspaceState,
  conversationId: string,
  submitState: DraftSubmitState,
  validationMessage: string | null,
): WorkspaceState {
  const nextDrafts = new Map(state.drafts);
  const current = ensureDraft(nextDrafts, conversationId);
  nextDrafts.set(conversationId, {
    ...current,
    submitState,
    validationMessage,
  });
  return { ...state, drafts: nextDrafts };
}

function applyConnectionPatch(
  state: WorkspaceState,
  patch: Readonly<Partial<WorkspaceConnectionState>>,
): WorkspaceState {
  return {
    ...state,
    connection: {
      ...state.connection,
      ...patch,
    },
  };
}

export function reduceWorkspaceState(
  state: WorkspaceState,
  action: WorkspaceAction,
): WorkspaceState {
  switch (action.type) {
    case 'conversation/upsert':
      return applyConversationUpsert(state, action.conversation);
    case 'conversation/replace-all':
      return applyReplaceAllConversations(state, action.conversations);
    case 'conversation/select':
      return applyConversationSelection(state, action.conversationId);
    case 'conversation/set-load-state':
      return applyConversationLoadState(state, action.conversationId, action.loadState);
    case 'conversation/replace-entries':
      return applyConversationEntries(
        state,
        action.conversationId,
        action.entries,
        action.hasMoreHistory,
      );
    case 'draft/set-text':
      return applyDraftText(state, action.conversationId, action.draftText);
    case 'draft/set-submit-state':
      return applyDraftSubmitState(
        state,
        action.conversationId,
        action.submitState,
        action.validationMessage,
      );
    case 'connection/merge':
      return applyConnectionPatch(state, action.patch);
    case 'artifact/show':
      return { ...state, visibleArtifact: action.artifact };
    case 'artifact/clear':
      return { ...state, visibleArtifact: null };
  }
}

export function createWorkspaceStore(initialState = createInitialWorkspaceState()): WorkspaceStore {
  let currentState = initialState;
  const listeners = new Set<WorkspaceListener>();

  return {
    getState(): WorkspaceState {
      return currentState;
    },

    dispatch(action: WorkspaceAction): void {
      currentState = reduceWorkspaceState(currentState, action);
      for (const listener of listeners) {
        listener(currentState, action);
      }
    },

    subscribe(listener: WorkspaceListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
