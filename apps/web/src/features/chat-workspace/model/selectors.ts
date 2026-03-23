/**
 * Derived selectors for the chat workspace.
 *
 * Each selector extracts a commonly-needed slice of WorkspaceState so UI
 * components never duplicate Map-lookup / active-id plumbing. All functions
 * are pure — no hidden state, no side effects.
 */

import type {
  ArtifactViewState,
  ComposerDraftState,
  ConversationLineageState,
  ConversationLoadState,
  ConversationViewState,
  EntryControlKind,
  EntryControlState,
  PromptViewState,
  TranscriptEntryState,
  WorkspaceState,
} from './workspace-types.ts';
import { getActiveDraft, isDraftSubmittable } from './composer-drafts.ts';
import { filterPendingPrompts } from './prompt-helpers.ts';
import { deduplicateEntries } from './reconciler.ts';

const EMPTY_ENTRIES: readonly TranscriptEntryState[] = [];

/** The view state of the currently active conversation, or `undefined`. */
export function selectActiveConversation(state: WorkspaceState): ConversationViewState | undefined {
  if (state.activeConversationId == null) return undefined;
  return state.conversations.get(state.activeConversationId);
}

/** The draft for the currently active conversation, or `undefined`. */
export function selectActiveDraft(state: WorkspaceState): ComposerDraftState | undefined {
  return getActiveDraft(state);
}

/** Transcript entries for the active conversation, deduplicated as a safety net. */
export function selectActiveEntries(state: WorkspaceState): readonly TranscriptEntryState[] {
  const conversation = selectActiveConversation(state);
  const raw = conversation?.entries ?? EMPTY_ENTRIES;
  if (raw.length <= 1) return raw;

  // Fast path: scan for duplicate turnIds or entryIds before allocating
  const seenTurnIds = new Set<string>();
  const seenEntryIds = new Set<string>();
  let hasDuplicates = false;
  for (const entry of raw) {
    if (entry.kind === 'turn' && entry.turnId != null) {
      if (seenTurnIds.has(entry.turnId)) {
        hasDuplicates = true;
        break;
      }
      seenTurnIds.add(entry.turnId);
    }
    if (seenEntryIds.has(entry.entryId)) {
      hasDuplicates = true;
      break;
    }
    seenEntryIds.add(entry.entryId);
  }

  return hasDuplicates ? deduplicateEntries(raw) : raw;
}

/** Load state of the active conversation, or `null` when nothing is active. */
export function selectActiveLoadState(state: WorkspaceState): ConversationLoadState | null {
  const conversation = selectActiveConversation(state);
  return conversation?.loadState ?? null;
}

/** The currently visible artifact panel state, or `null`. */
export function selectVisibleArtifact(state: WorkspaceState): ArtifactViewState | null {
  return state.visibleArtifact;
}

/**
 * Whether the operator can submit the active draft.
 *
 * Requires: an active conversation whose `controlState.canSubmit` is true,
 * and a draft that passes `isDraftSubmittable` (non-empty + idle).
 */
export function selectCanSubmit(state: WorkspaceState): boolean {
  const conversation = selectActiveConversation(state);
  if (conversation == null) return false;
  if (!conversation.controlState.canSubmit) return false;

  const draft = getActiveDraft(state);
  if (draft == null) return false;

  return isDraftSubmittable(draft);
}

/**
 * Whether the operator can submit in create mode (no active conversation).
 *
 * Requires: non-empty draft text, not currently submitting, and no
 * outstanding create error. Mirrors the continue-mode `isDraftSubmittable`
 * guard but operates on the local React state values instead of store state.
 */
export function selectCreateModeCanSubmit(
  createDraftText: string,
  createSubmitting: boolean,
  createError: string | null,
): boolean {
  return createDraftText.trim().length > 0 && !createSubmitting && createError == null;
}

/** Pending prompts from the active conversation's entries. */
export function selectPendingPrompts(state: WorkspaceState): readonly PromptViewState[] {
  return filterPendingPrompts(selectActiveEntries(state));
}

/** Ordered list of conversation view states matching `conversationOrder`. */
export function selectConversationList(state: WorkspaceState): readonly ConversationViewState[] {
  const result: ConversationViewState[] = [];
  for (const id of state.conversationOrder) {
    const conv = state.conversations.get(id);
    if (conv != null) {
      result.push(conv);
    }
  }
  return result;
}

/** Whether the active conversation's authoritative REST history has been loaded. */
export function selectIsHistoryLoaded(state: WorkspaceState): boolean {
  const conversation = selectActiveConversation(state);
  return conversation?.historyLoaded ?? false;
}

// ─── Lineage & control selectors ────────────────────────────────────────────

const EMPTY_CONTROLS: readonly EntryControlState[] = [];

/** Lineage summary for the active conversation, or `null`. */
export function selectConversationLineage(state: WorkspaceState): ConversationLineageState | null {
  return selectActiveConversation(state)?.lineageSummary ?? null;
}

/** Controls attached to a specific entry in the active conversation (deduped). */
export function selectEntryControls(
  state: WorkspaceState,
  entryId: string,
): readonly EntryControlState[] {
  const entries = selectActiveEntries(state);
  if (entries.length === 0) return EMPTY_CONTROLS;
  const entry = entries.find((e) => e.entryId === entryId);
  return entry?.controls ?? EMPTY_CONTROLS;
}

/** Stale reason from the active conversation's control state, or `null`. */
export function selectConversationStaleReason(state: WorkspaceState): string | null {
  return selectActiveConversation(state)?.controlState.staleReason ?? null;
}

/** Whether a specific turn in the active conversation is stale (deduped). */
export function selectIsTurnStale(state: WorkspaceState, turnId: string): boolean {
  const entries = selectActiveEntries(state);
  if (entries.length === 0) return false;
  const entry = entries.find((e) => e.turnId === turnId && e.kind === 'turn');
  return entry?.status === 'stale';
}

function findTurnEntry(state: WorkspaceState, turnId: string): TranscriptEntryState | undefined {
  const entries = selectActiveEntries(state);
  if (entries.length === 0) return undefined;
  return entries.find((e) => e.turnId === turnId && e.kind === 'turn');
}

function isConversationStale(state: WorkspaceState): boolean {
  return selectConversationStaleReason(state) != null;
}

/** Find the first control matching `kind` on a transcript entry. */
function findControlByKind(
  entry: TranscriptEntryState,
  kind: EntryControlKind,
): EntryControlState | undefined {
  return entry.controls.find((c) => c.kind === kind);
}

/** Whether the given turn can be retried (completed or failed, conversation not stale). */
export function selectCanRetry(state: WorkspaceState, turnId: string): boolean {
  const entry = findTurnEntry(state, turnId);
  if (entry == null) return false;

  const control = findControlByKind(entry, 'retry');
  if (control != null) return control.enabled;

  if (isConversationStale(state)) return false;
  return entry.status === 'completed' || entry.status === 'failed';
}

/** Whether the given turn can be branched from (completed, conversation not stale). */
export function selectCanBranch(state: WorkspaceState, turnId: string): boolean {
  const entry = findTurnEntry(state, turnId);
  if (entry == null) return false;

  const control = findControlByKind(entry, 'branch');
  if (control != null) return control.enabled;

  if (isConversationStale(state)) return false;
  return entry.status === 'completed';
}

/** Whether the given turn can be cancelled (currently streaming). */
export function selectCanCancel(state: WorkspaceState, turnId: string): boolean {
  const entry = findTurnEntry(state, turnId);
  if (entry == null) return false;

  const control = findControlByKind(entry, 'cancel');
  if (control != null) return control.enabled;

  return (
    entry.status === 'streaming' || entry.status === 'executing' || entry.status === 'submitted'
  );
}

/** Whether a follow-up can be submitted after the given turn (last completed turn, conversation not stale). */
export function selectCanFollowUp(state: WorkspaceState, turnId: string): boolean {
  const entry = findTurnEntry(state, turnId);
  if (entry == null) return false;

  const control = findControlByKind(entry, 'submit-follow-up');
  if (control != null) return control.enabled;

  if (isConversationStale(state)) return false;
  if (entry.status !== 'completed') return false;

  const entries = selectActiveEntries(state);
  if (entries.length === 0) return false;

  const turnEntries = entries.filter((e) => e.kind === 'turn');
  const lastCompletedTurn = turnEntries.findLast((candidate) => candidate.status === 'completed');
  return lastCompletedTurn?.turnId === turnId;
}
