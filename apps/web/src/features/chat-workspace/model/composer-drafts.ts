/**
 * Per-conversation draft ownership helpers.
 *
 * Pure functions that query draft state from the workspace without
 * duplicating Map-lookup or active-id logic across UI components.
 * Drafts are keyed per conversation and never migrate across conversations.
 */

import type { ComposerDraftState, WorkspaceState } from './workspace-store.ts';

/** Look up the draft for a specific conversation, or `undefined` if none exists. */
export function getDraft(
  state: WorkspaceState,
  conversationId: string,
): ComposerDraftState | undefined {
  return state.drafts.get(conversationId);
}

/** Look up the draft for the currently active conversation, or `undefined`. */
export function getActiveDraft(state: WorkspaceState): ComposerDraftState | undefined {
  if (state.activeConversationId == null) return undefined;
  return state.drafts.get(state.activeConversationId);
}

/** Whether the draft contains non-whitespace text. */
export function isDraftNonEmpty(draft: ComposerDraftState): boolean {
  return draft.draftText.trim().length > 0;
}

/**
 * Whether the draft is in a submittable state:
 * non-empty text and `submitState` is `'idle'`.
 */
export function isDraftSubmittable(draft: ComposerDraftState): boolean {
  return isDraftNonEmpty(draft) && draft.submitState === 'idle';
}

/** Whether the draft currently has a submission error. */
export function hasDraftError(draft: ComposerDraftState): boolean {
  return draft.submitState === 'error';
}
