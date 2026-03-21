/**
 * Stream subscription state management.
 *
 * Pure helpers for applying streaming events to workspace conversations via
 * the reconciler, plus the callback builder that routes WebSocket events
 * into the workspace store with per-conversation resume tracking and ack.
 *
 * The hook layer (workspace.tsx) owns the subscription lifecycle; this
 * module provides the stateless reconciliation dispatch and callback wiring.
 *
 * @module stream-subscription
 */

import type { StreamEvent } from '@hydra/web-contracts';

import type { StreamClientCallbacks } from '../api/stream-client.ts';
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
  /** Highest event seq processed — used for resume on resubscribe. */
  readonly lastAcknowledgedSeq: number | undefined;
}

/** Create a fresh subscription state with no high-water marks. */
export function createStreamSubscriptionState(): StreamSubscriptionState {
  return { reconcilerState: createReconcilerState(), lastAcknowledgedSeq: undefined };
}

// ─── Reconciliation dispatch ────────────────────────────────────────────────

/**
 * Apply a batch of stream events to a conversation's transcript entries.
 *
 * Reads the current entries from the store, runs reconciliation, and
 * dispatches `conversation/replace-entries` with the merged result.
 * Returns the updated subscription state (advanced high-water marks
 * and lastAcknowledgedSeq for resume capability).
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

  // Track the highest seq for resume on resubscribe
  let maxSeq = subscriptionState.lastAcknowledgedSeq;
  for (const event of events) {
    if (maxSeq === undefined || event.seq > maxSeq) {
      maxSeq = event.seq;
    }
  }

  return { reconcilerState: nextReconcilerState, lastAcknowledgedSeq: maxSeq };
}

// ─── Callback builder ───────────────────────────────────────────────────────

/** Lifecycle hooks consumed by the stream callback builder. */
export interface StreamLifecycleHooks {
  /** Invoked when the socket closes unexpectedly and reconnect should be attempted. */
  readonly onReconnectNeeded: () => void;
  /** Invoked when the WebSocket connection opens successfully. */
  readonly onConnectionEstablished: () => void;
}

/**
 * Build StreamClient callbacks that route events into the workspace store.
 *
 * Per-conversation reconciler state is stored in `stateMap` so it survives
 * conversation switches and reconnects. Each processed event is acknowledged
 * via the provided `ack` function for server-side buffer cleanup.
 */
export function buildStreamCallbacks(
  store: WorkspaceStore,
  stateMap: Map<string, StreamSubscriptionState>,
  ack: (conversationId: string, seq: number) => void,
  lifecycle: StreamLifecycleHooks,
): StreamClientCallbacks {
  return {
    onStreamEvent(conversationId, event) {
      const currentState = stateMap.get(conversationId) ?? createStreamSubscriptionState();
      const nextState = applyStreamEventsToConversation(
        store,
        conversationId,
        [event],
        currentState,
      );
      stateMap.set(conversationId, nextState);

      try {
        ack(conversationId, event.seq);
      } catch (err: unknown) {
        console.warn(`[stream] Failed to ack seq ${String(event.seq)} for ${conversationId}:`, err);
      }
    },
    onOpen() {
      store.dispatch({ type: 'connection/merge', patch: { transportStatus: 'live' } });
      lifecycle.onConnectionEstablished();
    },
    onClose(code) {
      store.dispatch({ type: 'connection/merge', patch: { transportStatus: 'disconnected' } });
      // Attempt reconnect for server-initiated or abnormal close.
      // Normal close (1000) means intentional shutdown — no reconnect.
      if (code !== 1000) {
        lifecycle.onReconnectNeeded();
      }
    },
    onSocketError() {
      store.dispatch({ type: 'connection/merge', patch: { transportStatus: 'reconnecting' } });
    },
    onSubscribed(_conversationId, _currentSeq) {
      // Server confirmed subscription. Replay events (if any) arrive via
      // onStreamEvent and are deduplicated by the reconciler's high-water marks.
    },
    onDaemonUnavailable() {
      store.dispatch({ type: 'connection/merge', patch: { daemonStatus: 'unavailable' } });
    },
    onDaemonRestored() {
      store.dispatch({ type: 'connection/merge', patch: { daemonStatus: 'healthy' } });
    },
    onSessionTerminated(sessionState) {
      const status = sessionState === 'logged-out' ? 'invalidated' : sessionState;
      store.dispatch({ type: 'connection/merge', patch: { sessionStatus: status } });
    },
    onSessionExpiringSoon() {
      store.dispatch({ type: 'connection/merge', patch: { sessionStatus: 'expiring-soon' } });
    },
  };
}
