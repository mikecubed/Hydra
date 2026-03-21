/**
 * Stream subscription state management.
 *
 * Pure helpers for applying streaming events to workspace conversations via
 * the reconciler. The hook layer (workspace.tsx) owns the subscription
 * lifecycle; this module provides the stateless reconciliation dispatch.
 *
 * @module stream-subscription
 */

import type { StreamEvent } from '@hydra/web-contracts';

import {
  createReconcilerState,
  reconcileStreamEvents,
  type ReconcilerState,
} from './reconciler.ts';
import type { WorkspaceStore } from './workspace-types.ts';

// ─── Subscription state ─────────────────────────────────────────────────────

/** Per-conversation reconciler tracking for the stream subscription layer. */
export interface StreamSubscriptionState {
  readonly reconcilerState: ReconcilerState;
}

/** Create a fresh subscription state with no high-water marks. */
export function createStreamSubscriptionState(): StreamSubscriptionState {
  return { reconcilerState: createReconcilerState() };
}

// ─── Reconciliation dispatch ────────────────────────────────────────────────

/**
 * Apply a batch of stream events to a conversation's transcript entries.
 *
 * Reads the current entries from the store, runs reconciliation, and
 * dispatches `conversation/replace-entries` with the merged result.
 * Returns the updated subscription state (advanced high-water marks).
 *
 * No-ops (returns unchanged state) when the conversation does not exist
 * in the store — the caller should only route events for known conversations.
 */
export function applyStreamEventsToConversation(
  store: WorkspaceStore,
  conversationId: string,
  events: readonly StreamEvent[],
  subscriptionState: StreamSubscriptionState,
): StreamSubscriptionState {
  const conversation = store.getState().conversations.get(conversationId);
  if (conversation == null) return subscriptionState;

  const { entries, state: nextReconcilerState } = reconcileStreamEvents(
    conversation.entries,
    events,
    subscriptionState.reconcilerState,
  );

  // Only dispatch when reconciliation actually mutated the entries array.
  if (entries !== conversation.entries) {
    store.dispatch({
      type: 'conversation/replace-entries',
      conversationId,
      entries,
      hasMoreHistory: conversation.hasMoreHistory,
    });
  }

  return { reconcilerState: nextReconcilerState };
}
