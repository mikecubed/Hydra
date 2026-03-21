/**
 * Pure reducer for the chat workspace state machine.
 *
 * Extracted from workspace-store.ts — contains the initial-state factory,
 * all per-action reducers, and the top-level `reduceWorkspaceState` switch.
 * No side effects; every function is a pure (state, action) → state transform.
 */

import {
  initialConnectionState,
  type WorkspaceConnectionState,
} from '../../../shared/session-state.ts';

import type {
  ComposerDraftState,
  ConversationLineageState,
  ConversationLoadState,
  ConversationStatus,
  ConversationViewState,
  DraftSubmitState,
  TranscriptEntryState,
  WorkspaceAction,
  WorkspaceConversationRecord,
  WorkspaceState,
} from './workspace-types.ts';

// ─── Internal helpers ───────────────────────────────────────────────────────

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
    status: conversation.status ?? 'active',
    createdAt: conversation.createdAt ?? null,
    updatedAt: conversation.updatedAt ?? null,
    turnCount: conversation.turnCount ?? 0,
    pendingInstructionCount: conversation.pendingInstructionCount ?? 0,
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

function resolveConversationText(
  nextValue: string | undefined,
  previousValue: string | undefined,
  fallback: string,
): string {
  return nextValue ?? previousValue ?? fallback;
}

function resolveConversationStatus(
  nextValue: ConversationStatus | undefined,
  previousValue: ConversationStatus | undefined,
): ConversationStatus {
  return nextValue ?? previousValue ?? 'active';
}

function resolveConversationTimestamp(
  nextValue: string | undefined,
  previousValue: string | null | undefined,
): string | null {
  return nextValue ?? previousValue ?? null;
}

function resolveConversationCount(
  nextValue: number | undefined,
  previousValue: number | undefined,
): number {
  return nextValue ?? previousValue ?? 0;
}

function mergeConversationSnapshot(
  previous: ConversationViewState | undefined,
  conversation: WorkspaceConversationRecord,
): Pick<
  ConversationViewState,
  'title' | 'status' | 'createdAt' | 'updatedAt' | 'turnCount' | 'pendingInstructionCount'
> {
  return {
    title: resolveConversationText(conversation.title, previous?.title, 'Untitled conversation'),
    status: resolveConversationStatus(conversation.status, previous?.status),
    createdAt: resolveConversationTimestamp(conversation.createdAt, previous?.createdAt),
    updatedAt: resolveConversationTimestamp(conversation.updatedAt, previous?.updatedAt),
    turnCount: resolveConversationCount(conversation.turnCount, previous?.turnCount),
    pendingInstructionCount: resolveConversationCount(
      conversation.pendingInstructionCount,
      previous?.pendingInstructionCount,
    ),
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

// ─── Exported state factory ─────────────────────────────────────────────────

export function createInitialWorkspaceState(): WorkspaceState {
  return {
    activeConversationId: null,
    explicitCreateMode: false,
    conversationOrder: [],
    conversations: new Map(),
    drafts: new Map(),
    connection: initialConnectionState(),
    visibleArtifact: null,
  };
}

// ─── Per-action reducers ────────────────────────────────────────────────────

function mergeConversationView(
  previous: ConversationViewState | undefined,
  conversation: WorkspaceConversationRecord,
): ConversationViewState {
  const snapshot = mergeConversationSnapshot(previous, conversation);

  return {
    ...(previous ?? createConversationViewState(conversation)),
    conversationId: conversation.id,
    ...snapshot,
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

  // Retain the active conversation when it was already known locally but
  // absent from this (possibly stale/paginated) list payload.  An empty
  // payload is treated as authoritative ("no conversations exist"), so we
  // only protect the active conversation when the refresh is non-empty.
  const activeId = state.activeConversationId;
  const retainedActiveConversation =
    activeId == null || conversations.length === 0 || nextConversations.has(activeId)
      ? undefined
      : state.conversations.get(activeId);
  if (activeId != null && retainedActiveConversation != null) {
    nextConversations.set(activeId, retainedActiveConversation);
    nextOrder.push(activeId);
  }

  const currentStillExists = activeId != null && nextConversations.has(activeId);
  let fallbackId: string | null = null;
  if (!state.explicitCreateMode && nextOrder.length > 0) {
    fallbackId = nextOrder[0];
  }
  const nextActiveConversationId = currentStillExists ? activeId : fallbackId;
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
    return {
      ...state,
      activeConversationId: null,
      explicitCreateMode: true,
      visibleArtifact: null,
    };
  }

  const nextConversations = new Map(state.conversations);
  if (!nextConversations.has(conversationId)) {
    nextConversations.set(conversationId, createConversationViewState({ id: conversationId }));
  }

  const nextDrafts = withDraft(state.drafts, conversationId);

  return {
    ...state,
    activeConversationId: conversationId,
    explicitCreateMode: false,
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

// ─── Top-level reducer ──────────────────────────────────────────────────────

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
