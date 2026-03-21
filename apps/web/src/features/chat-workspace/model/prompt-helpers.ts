/**
 * Pure helpers and async flow for prompt lifecycle UI.
 *
 * Extracted from prompt-card so that node:test can exercise the logic
 * without importing JSX modules.
 */

import { GatewayRequestError } from '../api/gateway-client.ts';
import type { GatewayClient } from '../api/gateway-client.ts';
import type { PromptStatus, PromptViewState, WorkspaceStore } from './workspace-types.ts';

// ─── Pure helpers ───────────────────────────────────────────────────────────

const STATUS_LABELS: Record<PromptStatus, string> = {
  pending: '⏳ Approval pending',
  responding: '⏳ Submitting response…',
  resolved: '✓ Approval resolved',
  stale: '⚠ Approval stale',
  unavailable: '✕ Approval unavailable',
  error: '✕ Response failed',
};

/** Human-readable label for a prompt status. */
export function getPromptStatusLabel(status: PromptStatus): string {
  return STATUS_LABELS[status];
}

/** Whether the prompt can accept a new response. */
export function isPromptActionable(status: PromptStatus): boolean {
  return status === 'pending' || status === 'error';
}

/** Whether the prompt is in a terminal (non-actionable, non-transient) state. */
export function isPromptTerminal(status: PromptStatus): boolean {
  return status === 'resolved' || status === 'stale' || status === 'unavailable';
}

// ─── Async respond flow ─────────────────────────────────────────────────────

export interface RespondToPromptDeps {
  readonly store: WorkspaceStore;
  readonly client: Pick<GatewayClient, 'respondToApproval'>;
}

export interface RespondToPromptResult {
  readonly ok: boolean;
  readonly error?: string;
}

/**
 * Submit a response to a pending prompt.
 *
 * Orchestrates the optimistic state transition → API call → confirm/fail
 * cycle using existing reducer actions. Guards against non-pending prompts
 * and duplicate submissions.
 */
export async function respondToPrompt(
  deps: RespondToPromptDeps,
  params: {
    readonly conversationId: string;
    readonly turnId: string;
    readonly promptId: string;
    readonly response: string;
  },
): Promise<RespondToPromptResult> {
  const { store, client } = deps;
  const { conversationId, turnId, promptId, response } = params;

  // Guard: only pending prompts can be responded to
  const conv = store.getState().conversations.get(conversationId);
  const entry = conv?.entries.find((e) => e.turnId === turnId && e.prompt?.promptId === promptId);

  if (!entry?.prompt || !isPromptActionable(entry.prompt.status)) {
    return { ok: false, error: 'Prompt is not actionable' };
  }

  // Optimistic transition → responding
  store.dispatch({ type: 'prompt/begin-response', conversationId, turnId, promptId });

  try {
    await client.respondToApproval(promptId, { response });
    store.dispatch({
      type: 'prompt/response-confirmed',
      conversationId,
      turnId,
      promptId,
      responseSummary: response,
    });
    return { ok: true };
  } catch (err: unknown) {
    if (err instanceof GatewayRequestError) {
      if (err.status === 404) {
        store.dispatch({ type: 'prompt/mark-unavailable', conversationId, turnId, promptId });
        return { ok: false, error: err.message };
      }

      if (err.status === 409) {
        store.dispatch({
          type: 'prompt/mark-stale',
          conversationId,
          turnId,
          promptId,
          reason: err.gatewayError.message,
        });
        return { ok: false, error: err.message };
      }
    }

    const errorMessage = err instanceof Error ? err.message : 'Failed to submit response';
    store.dispatch({
      type: 'prompt/response-failed',
      conversationId,
      turnId,
      promptId,
      errorMessage,
    });
    return { ok: false, error: errorMessage };
  }
}

// ─── Prompt selectors ───────────────────────────────────────────────────────

/** Extract all pending prompts from a flat entries array. */
export function filterPendingPrompts(
  entries: readonly { readonly prompt: PromptViewState | null }[],
): readonly PromptViewState[] {
  const result: PromptViewState[] = [];
  for (const entry of entries) {
    if (entry.prompt?.status === 'pending') {
      result.push(entry.prompt);
    }
  }
  return result;
}
