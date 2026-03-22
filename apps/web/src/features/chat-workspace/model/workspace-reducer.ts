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
  PromptStatus,
  PromptViewState,
  TranscriptEntryState,
  WorkspaceAction,
  WorkspaceConversationRecord,
  WorkspaceState,
} from './workspace-types.ts';

import { mergeAuthoritativeEntries } from './reconciler.ts';

// ─── Internal helpers ───────────────────────────────────────────────────────

const DEFAULT_SUBMISSION_POLICY_LABEL = 'Ready for operator input';

/**
 * Prompt lifecycle status priority for merge conflict resolution.
 * Higher rank = more advanced in the lifecycle.
 */
const PROMPT_STATUS_RANK: Record<PromptStatus, number> = {
  pending: 0,
  responding: 1,
  error: 2,
  stale: 3,
  unavailable: 3,
  resolved: 4,
};

function shouldPreferFallbackSummary(
  preferred: PromptViewState,
  fallback: PromptViewState,
): boolean {
  if (
    preferred.status !== 'resolved' ||
    fallback.status !== 'resolved' ||
    preferred.lastResponseSummary == null ||
    fallback.lastResponseSummary == null ||
    preferred.lastResponseSummary === fallback.lastResponseSummary
  ) {
    return false;
  }

  return fallback.allowedResponses.some(
    (choice) =>
      typeof choice !== 'string' &&
      choice.key === preferred.lastResponseSummary &&
      choice.label === fallback.lastResponseSummary,
  );
}

const TURN_STATUS_RANK: Readonly<Record<string, number>> = {
  submitted: 0,
  executing: 1,
  streaming: 2,
  completed: 3,
  failed: 3,
  cancelled: 3,
};

function measureEntryContent(entry: TranscriptEntryState): number {
  return entry.contentBlocks.reduce(
    (size, block) => size + block.blockId.length + (block.text?.length ?? 0),
    0,
  );
}

function shouldPreferStreamedTurn(
  streamed: TranscriptEntryState,
  rest: TranscriptEntryState,
): boolean {
  const streamedRank = TURN_STATUS_RANK[streamed.status] ?? 0;
  const restRank = TURN_STATUS_RANK[rest.status] ?? 0;
  if (streamedRank !== restRank) {
    return streamedRank > restRank;
  }

  return measureEntryContent(streamed) > measureEntryContent(rest);
}

/**
 * Merge two prompt states for the same turn, preferring the more advanced
 * lifecycle state. Used during history merge where stream and REST may have
 * different views of the same prompt.
 */
function mergePromptState(
  streamPrompt: PromptViewState | null,
  restPrompt: PromptViewState | null,
): PromptViewState | null {
  if (streamPrompt == null) return restPrompt;
  if (restPrompt == null) return streamPrompt;

  // Same prompt — prefer the more advanced lifecycle state
  if (streamPrompt.promptId === restPrompt.promptId) {
    const preserveStreamLifecycle =
      (streamPrompt.status === 'responding' || streamPrompt.status === 'error') &&
      (restPrompt.status === 'pending' || restPrompt.status === 'stale');
    const streamRank = PROMPT_STATUS_RANK[streamPrompt.status];
    const restRank = PROMPT_STATUS_RANK[restPrompt.status];
    const preferred = preserveStreamLifecycle || restRank <= streamRank ? streamPrompt : restPrompt;
    const fallback = preferred === streamPrompt ? restPrompt : streamPrompt;
    const lastResponseSummary = shouldPreferFallbackSummary(preferred, fallback)
      ? fallback.lastResponseSummary
      : (preferred.lastResponseSummary ?? fallback.lastResponseSummary);
    return {
      ...preferred,
      allowedResponses:
        preferred.allowedResponses.length > 0
          ? preferred.allowedResponses
          : fallback.allowedResponses,
      contextBlocks:
        preferred.contextBlocks.length > 0 ? preferred.contextBlocks : fallback.contextBlocks,
      lastResponseSummary,
      errorMessage: preferred.errorMessage ?? fallback.errorMessage,
    };
  }

  // Different prompts — stream is more recent
  return streamPrompt;
}

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
    historyLoaded: false,
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

export { mergePromptState };

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

type PromptAction = Extract<
  WorkspaceAction,
  {
    readonly type:
      | 'prompt/begin-response'
      | 'prompt/response-confirmed'
      | 'prompt/response-failed'
      | 'prompt/mark-stale'
      | 'prompt/mark-unavailable'
      | 'prompt/hydrate';
  }
>;

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

/**
 * Merge authoritative REST history into the conversation, preserving any
 * stream-owned entries for turns not present in the REST response.
 *
 * Delegates to `mergeAuthoritativeEntries` from the reconciler module for
 * the pure entry-merge algorithm. For non-terminal REST turns the stream's
 * status and contentBlocks are preserved (the stream is likely ahead of the
 * last REST snapshot); for terminal turns REST is fully authoritative.
 *
 * Sets `historyLoaded: true` so the transcript loader knows not to re-fetch.
 */
function applyMergeHistory(
  state: WorkspaceState,
  conversationId: string,
  restEntries: readonly TranscriptEntryState[],
  hasMoreHistory: boolean,
): WorkspaceState {
  const current = ensureConversation(state.conversations, conversationId);
  const nextConversations = new Map(state.conversations);
  const merged = mergeAuthoritativeEntries(restEntries, current.entries);

  nextConversations.set(conversationId, {
    ...current,
    entries: merged,
    hasMoreHistory,
    loadState: 'ready',
    historyLoaded: true,
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

/**
 * Append a single operator turn (from a submit response) to the transcript.
 *
 * Deduplicates by turnId — if the turn is already present (e.g. via stream
 * replay), the existing entry is kept unchanged. Does not modify
 * `historyLoaded` or `loadState`, avoiding the race where a full re-fetch
 * could clobber live stream state.
 */
function applyAppendSubmitTurn(
  state: WorkspaceState,
  conversationId: string,
  entry: TranscriptEntryState,
): WorkspaceState {
  const current = ensureConversation(state.conversations, conversationId);

  if (entry.turnId != null && current.entries.some((e) => e.turnId === entry.turnId)) {
    return state;
  }

  const nextConversations = new Map(state.conversations);
  nextConversations.set(conversationId, {
    ...current,
    entries: [...current.entries, entry],
  });
  return {
    ...state,
    conversationOrder: withConversationInOrder(state.conversationOrder, conversationId),
    conversations: nextConversations,
  };
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

function patchPrompt(
  prompt: PromptViewState,
  patch: Readonly<Partial<PromptViewState>>,
): PromptViewState {
  return {
    ...prompt,
    ...patch,
  };
}

function updatePromptEntry(
  entry: TranscriptEntryState,
  promptId: string,
  updater: (prompt: PromptViewState) => PromptViewState,
): TranscriptEntryState {
  if (entry.kind !== 'turn' || entry.prompt?.promptId !== promptId) {
    return entry;
  }

  return {
    ...entry,
    prompt: updater(entry.prompt),
  };
}

function applyPromptUpdate(
  state: WorkspaceState,
  conversationId: string,
  turnId: string,
  promptId: string,
  updater: (prompt: PromptViewState) => PromptViewState,
): WorkspaceState {
  const current = ensureConversation(state.conversations, conversationId);
  const nextEntries = current.entries.map((entry) =>
    entry.turnId === turnId ? updatePromptEntry(entry, promptId, updater) : entry,
  );
  const changed = nextEntries.some((entry, index) => entry !== current.entries[index]);

  if (!changed) {
    return state;
  }

  const nextConversations = new Map(state.conversations);
  nextConversations.set(conversationId, {
    ...current,
    entries: nextEntries,
  });
  return {
    ...state,
    conversationOrder: withConversationInOrder(state.conversationOrder, conversationId),
    conversations: nextConversations,
  };
}

function applyPromptBeginResponse(
  state: WorkspaceState,
  conversationId: string,
  turnId: string,
  promptId: string,
): WorkspaceState {
  return applyPromptUpdate(state, conversationId, turnId, promptId, (prompt) => {
    if (prompt.status !== 'pending' && prompt.status !== 'error') return prompt;
    return patchPrompt(prompt, { status: 'responding', errorMessage: null });
  });
}

function applyPromptResponseConfirmed(
  state: WorkspaceState,
  conversationId: string,
  turnId: string,
  promptId: string,
  responseSummary: string | null,
): WorkspaceState {
  return applyPromptUpdate(state, conversationId, turnId, promptId, (prompt) => {
    if (prompt.status !== 'responding' && prompt.status !== 'stale') return prompt;
    return patchPrompt(prompt, {
      status: 'resolved',
      lastResponseSummary: responseSummary,
      errorMessage: null,
      staleReason: null,
    });
  });
}

function applyPromptResponseFailed(
  state: WorkspaceState,
  conversationId: string,
  turnId: string,
  promptId: string,
  errorMessage: string | null,
): WorkspaceState {
  return applyPromptUpdate(state, conversationId, turnId, promptId, (prompt) => {
    if (prompt.status !== 'responding') return prompt;
    return patchPrompt(prompt, { status: 'error', errorMessage });
  });
}

function applyPromptMarkStale(
  state: WorkspaceState,
  conversationId: string,
  turnId: string,
  promptId: string,
  reason: string | null,
): WorkspaceState {
  return applyPromptUpdate(state, conversationId, turnId, promptId, (prompt) => {
    if (prompt.status !== 'pending' && prompt.status !== 'responding') return prompt;
    return patchPrompt(prompt, { status: 'stale', staleReason: reason });
  });
}

function applyPromptMarkUnavailable(
  state: WorkspaceState,
  conversationId: string,
  turnId: string,
  promptId: string,
): WorkspaceState {
  return applyPromptUpdate(state, conversationId, turnId, promptId, (prompt) => {
    if (prompt.status === 'resolved') return prompt;
    return patchPrompt(prompt, { status: 'unavailable' });
  });
}

function applyPromptHydrate(
  state: WorkspaceState,
  conversationId: string,
  turnId: string,
  promptId: string,
  allowedResponses: PromptViewState['allowedResponses'],
  contextBlocks: PromptViewState['contextBlocks'],
): WorkspaceState {
  return applyPromptUpdate(state, conversationId, turnId, promptId, (prompt) =>
    patchPrompt(prompt, {
      allowedResponses: [...allowedResponses],
      contextBlocks: [...contextBlocks],
    }),
  );
}

function isPromptAction(action: WorkspaceAction): action is PromptAction {
  return action.type.startsWith('prompt/');
}

function applyPromptAction(state: WorkspaceState, action: PromptAction): WorkspaceState {
  switch (action.type) {
    case 'prompt/begin-response':
      return applyPromptBeginResponse(state, action.conversationId, action.turnId, action.promptId);
    case 'prompt/response-confirmed':
      return applyPromptResponseConfirmed(
        state,
        action.conversationId,
        action.turnId,
        action.promptId,
        action.responseSummary,
      );
    case 'prompt/response-failed':
      return applyPromptResponseFailed(
        state,
        action.conversationId,
        action.turnId,
        action.promptId,
        action.errorMessage,
      );
    case 'prompt/mark-stale':
      return applyPromptMarkStale(
        state,
        action.conversationId,
        action.turnId,
        action.promptId,
        action.reason,
      );
    case 'prompt/mark-unavailable':
      return applyPromptMarkUnavailable(
        state,
        action.conversationId,
        action.turnId,
        action.promptId,
      );
    case 'prompt/hydrate':
      return applyPromptHydrate(
        state,
        action.conversationId,
        action.turnId,
        action.promptId,
        action.allowedResponses,
        action.contextBlocks,
      );
  }
}

// ─── Top-level reducer ──────────────────────────────────────────────────────

export function reduceWorkspaceState(
  state: WorkspaceState,
  action: WorkspaceAction,
): WorkspaceState {
  if (isPromptAction(action)) {
    return applyPromptAction(state, action);
  }

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
    case 'conversation/merge-history':
      return applyMergeHistory(state, action.conversationId, action.entries, action.hasMoreHistory);
    case 'conversation/append-submit-turn':
      return applyAppendSubmitTurn(state, action.conversationId, action.entry);
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
