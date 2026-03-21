/**
 * Async submit orchestration for the chat workspace.
 *
 * Extracted from workspace-store.ts — contains the "continue" and "create"
 * submit flows that coordinate GatewayClient calls with WorkspaceStore
 * dispatches. These are the only async (side-effecting) functions in the
 * workspace model layer.
 */

import { isDraftSubmittable } from './composer-drafts.ts';
import type { GatewayClient } from '../api/gateway-client.ts';
import type { WorkspaceStore } from './workspace-types.ts';

// ─── Public types ───────────────────────────────────────────────────────────

export interface SubmitDraftDeps {
  readonly store: WorkspaceStore;
  readonly client: Pick<GatewayClient, 'createConversation' | 'submitInstruction'>;
}

export type SubmitResult = { readonly ok: true } | { readonly ok: false };

// ─── Submit flows ───────────────────────────────────────────────────────────

/**
 * Continue flow: submit the active draft as an instruction to the
 * active conversation. Manages submitting → idle/error transitions.
 *
 * No-ops when there is no active conversation, the draft is empty,
 * or the draft is already in-flight (returns `{ ok: false }`).
 */
export async function submitComposerDraft(deps: SubmitDraftDeps): Promise<SubmitResult> {
  const { store, client } = deps;
  const state = store.getState();
  const conversationId = state.activeConversationId;

  if (conversationId == null) return { ok: false };

  const draft = state.drafts.get(conversationId);
  if (draft == null || !isDraftSubmittable(draft)) return { ok: false };

  const instruction = draft.draftText.trim();

  store.dispatch({
    type: 'draft/set-submit-state',
    conversationId,
    submitState: 'submitting',
    validationMessage: null,
  });

  try {
    await client.submitInstruction(conversationId, { instruction });

    store.dispatch({ type: 'draft/set-text', conversationId, draftText: '' });
    store.dispatch({
      type: 'draft/set-submit-state',
      conversationId,
      submitState: 'idle',
      validationMessage: null,
    });
    store.dispatch({
      type: 'conversation/set-load-state',
      conversationId,
      loadState: 'idle',
    });
    return { ok: true };
  } catch (err: unknown) {
    store.dispatch({
      type: 'draft/set-submit-state',
      conversationId,
      submitState: 'error',
      validationMessage: err instanceof Error ? err.message : 'Submission failed',
    });
    return { ok: false };
  }
}

/**
 * Create flow: create a new conversation, select it, and submit the
 * initial instruction via `submitComposerDraft`.
 *
 * No-ops when `draftText` is empty or whitespace-only (returns `{ ok: false }`).
 * Throws if `createConversation` fails (no conversation to record
 * the error against). Submit errors after creation are recorded on
 * the new conversation's draft state via `submitComposerDraft`.
 */
export async function createAndSubmitDraft(
  deps: SubmitDraftDeps,
  draftText: string,
): Promise<SubmitResult> {
  const { store, client } = deps;
  const instruction = draftText.trim();
  if (instruction === '') return { ok: false };

  const created = await client.createConversation({});

  store.dispatch({
    type: 'conversation/upsert',
    conversation: {
      id: created.id,
      title: created.title,
      status: created.status,
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
      turnCount: created.turnCount,
      pendingInstructionCount: created.pendingInstructionCount,
    },
  });
  store.dispatch({ type: 'conversation/select', conversationId: created.id });
  store.dispatch({ type: 'draft/set-text', conversationId: created.id, draftText: instruction });

  return submitComposerDraft(deps);
}
