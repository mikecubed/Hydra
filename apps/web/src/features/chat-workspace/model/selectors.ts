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

/** Whether the given turn can be cancelled (streaming, executing, or submitted). */
export function selectCanCancel(state: WorkspaceState, turnId: string): boolean {
  const entry = findTurnEntry(state, turnId);
  if (entry == null) return false;

  const control = findControlByKind(entry, 'cancel');
  if (control != null) return control.enabled;

  return isCancellableStatus(entry.status);
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

// ─── Combined action-flags selector ─────────────────────────────────────────

/** All-false sentinel — avoids allocating a new object on every miss. */
export const NO_ACTION_FLAGS: EntryActionFlags = Object.freeze({
  canCancel: false,
  canRetry: false,
  canBranch: false,
  canFollowUp: false,
});

/** Per-entry action eligibility flags, mirroring {@link EntryActionFlags}. */
export interface EntryActionFlags {
  readonly canCancel: boolean;
  readonly canRetry: boolean;
  readonly canBranch: boolean;
  readonly canFollowUp: boolean;
}

function isCancellableStatus(status: TranscriptEntryState['status']): boolean {
  return status === 'streaming' || status === 'executing' || status === 'submitted';
}

function computeRetryFlag(entry: TranscriptEntryState, stale: boolean): boolean {
  const retryCtrl = findControlByKind(entry, 'retry');
  if (retryCtrl != null) return retryCtrl.enabled;
  if (stale) return false;
  return entry.status === 'completed' || entry.status === 'failed';
}

function computeBranchFlag(entry: TranscriptEntryState, stale: boolean): boolean {
  const branchCtrl = findControlByKind(entry, 'branch');
  if (branchCtrl != null) return branchCtrl.enabled;
  if (stale) return false;
  return entry.status === 'completed';
}

function computeFollowUpFlag(
  entry: TranscriptEntryState,
  stale: boolean,
  lastCompletedTurnId: string | null,
): boolean {
  const followUpCtrl = findControlByKind(entry, 'submit-follow-up');
  if (followUpCtrl != null) return followUpCtrl.enabled;
  if (stale || entry.status !== 'completed') return false;
  return lastCompletedTurnId === entry.turnId;
}

function computeEntryActionFlags(
  entry: TranscriptEntryState,
  stale: boolean,
  lastCompletedTurnId: string | null,
): EntryActionFlags {
  const cancelCtrl = findControlByKind(entry, 'cancel');
  const canCancel = cancelCtrl == null ? isCancellableStatus(entry.status) : cancelCtrl.enabled;

  return {
    canCancel,
    canRetry: computeRetryFlag(entry, stale),
    canBranch: computeBranchFlag(entry, stale),
    canFollowUp: computeFollowUpFlag(entry, stale, lastCompletedTurnId),
  };
}

/**
 * Compute all four action-eligibility flags for a given turn in one pass.
 *
 * This is a performance-oriented replacement for calling
 * `selectCanCancel` / `selectCanRetry` / `selectCanBranch` / `selectCanFollowUp`
 * individually — those each call `selectActiveEntries()`, so calling all four
 * per entry makes the render loop O(N²). This selector calls it once.
 */
export function selectEntryActionFlags(state: WorkspaceState, turnId: string): EntryActionFlags {
  const entries = selectActiveEntries(state);
  if (entries.length === 0) return NO_ACTION_FLAGS;

  const entry = entries.find((e) => e.turnId === turnId && e.kind === 'turn');
  if (entry == null) return NO_ACTION_FLAGS;

  const stale = isConversationStale(state);
  const turnEntries = entries.filter((e) => e.kind === 'turn');
  const lastCompleted = turnEntries.findLast((candidate) => candidate.status === 'completed');
  return computeEntryActionFlags(entry, stale, lastCompleted?.turnId ?? null);
}

// ─── Whole-transcript precompute ────────────────────────────────────────────

/**
 * Precompute action flags for every turn in the active transcript in a single
 * O(N) pass. Returns a Map keyed by turnId.
 *
 * This replaces per-entry calls to {@link selectEntryActionFlags} during
 * render, eliminating the repeated `selectActiveEntries` scans that made the
 * old path O(N²).
 */
export function precomputeTranscriptActions(
  state: WorkspaceState,
  entries?: readonly TranscriptEntryState[],
): ReadonlyMap<string, EntryActionFlags> {
  const resolved = entries ?? selectActiveEntries(state);
  if (resolved.length === 0) return new Map();

  const stale = isConversationStale(state);

  // Single pass to find the last completed turn (needed for canFollowUp).
  let lastCompletedTurnId: string | null = null;
  for (let i = resolved.length - 1; i >= 0; i--) {
    const e = resolved[i];
    if (e.kind === 'turn' && e.status === 'completed' && e.turnId != null) {
      lastCompletedTurnId = e.turnId;
      break;
    }
  }

  const result = new Map<string, EntryActionFlags>();

  for (const entry of resolved) {
    if (entry.kind !== 'turn' || entry.turnId == null) continue;
    result.set(entry.turnId, computeEntryActionFlags(entry, stale, lastCompletedTurnId));
  }

  return result;
}
