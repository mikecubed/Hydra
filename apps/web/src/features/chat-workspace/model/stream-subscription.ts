/**
 * Stream subscription state management.
 *
 * Pure helpers for applying streaming events to workspace conversations via
 * the reconciler, plus the callback builder that routes WebSocket events
 * into the workspace store with per-conversation resume tracking and ack.
 *
 * Resume semantics use a **contiguous frontier** model: the reconnect
 * cursor (`serverResumeSeq`) only advances through consecutive consumed
 * seqs. Gaps created by ignored conditional events (e.g. mismatched
 * approval-response) block the frontier so those events remain
 * replay-eligible after reconnect. In callback mode, the frontier only
 * advances after a successful ack send.
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
  isStaleEvent,
  reconcileStreamEvents,
  sealAuthoritativeTurns,
  type ReconcilerState,
} from './reconciler.ts';
import type { TranscriptEntryState } from './workspace-types.ts';
import type { WorkspaceStore } from './workspace-types.ts';

// ─── Subscription state ─────────────────────────────────────────────────────

/** Per-conversation reconciler tracking for the stream subscription layer. */
export interface StreamSubscriptionState {
  readonly reconcilerState: ReconcilerState;
  /**
   * Contiguous server-safe resume cursor. Highest seq N where every seq
   * in (0, N] is either consumed by the reconciler or below the
   * `onSubscribed` baseline. Used for subscribe() on reconnect — server
   * replays `seq > serverResumeSeq`.
   *
   * In callback mode (`buildStreamCallbacks`), only advanced after a
   * successful ack. In pure mode (direct `applyStreamEventsToConversation`
   * calls), advanced immediately.
   */
  readonly serverResumeSeq: number | undefined;
  /**
   * Seqs received but not consumed by the reconciler (e.g. conditional
   * events like approval-response with no matching prompt). These block
   * the contiguous resume frontier so they remain replay-eligible.
   */
  readonly pendingSeqs: ReadonlySet<number>;
  /** Highest event seq received for this conversation. Bounds the frontier. */
  readonly highestSeenSeq: number | undefined;
}

/** Create a fresh subscription state with no high-water marks. */
export function createStreamSubscriptionState(): StreamSubscriptionState {
  return {
    reconcilerState: createReconcilerState(),
    serverResumeSeq: undefined,
    pendingSeqs: new Set(),
    highestSeenSeq: undefined,
  };
}

// ─── Contiguous resume computation ──────────────────────────────────────────

/**
 * Compute the contiguous resume cursor. The frontier advances from `base`
 * through all seqs up to `highestSeenSeq` that are not in `pendingSeqs`.
 * Stops at the first pending seq (gap).
 *
 * O(|pendingSeqs|) — finds the lowest pending seq above the base rather
 * than iterating through every seq in the range.
 */
export function computeContiguousResume(
  base: number | undefined,
  pendingSeqs: ReadonlySet<number>,
  highestSeenSeq: number | undefined,
): number | undefined {
  if (highestSeenSeq === undefined) return base;
  const start = base === undefined ? 0 : base + 1;
  if (start > highestSeenSeq) return base;

  // Find the lowest pending seq at or above start — the frontier cannot pass it.
  let minPending = Infinity;
  for (const seq of pendingSeqs) {
    if (seq >= start && seq < minPending) minPending = seq;
  }

  const frontier = Math.min(minPending - 1, highestSeenSeq);
  return frontier >= start ? frontier : base;
}

// ─── Reconciliation dispatch ────────────────────────────────────────────────

/**
 * Apply a batch of stream events to a conversation's transcript entries.
 *
 * Reads the current entries from the store, runs reconciliation, and
 * dispatches `conversation/replace-entries` with the merged result.
 * Returns the updated subscription state with contiguously-advanced
 * `serverResumeSeq` and updated `pendingSeqs`.
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

  const {
    entries,
    state: nextReconcilerState,
    consumedSeqs,
  } = reconcileStreamEvents(conversation.entries, events, subscriptionState.reconcilerState);

  // Only dispatch when reconciliation actually mutated the entries array.
  if (entries !== conversation.entries) {
    store.dispatch({
      type: 'conversation/replace-entries',
      conversationId,
      entries,
      hasMoreHistory: conversation.hasMoreHistory,
    });
  }

  // Update pendingSeqs and highestSeenSeq from this batch.
  const nextPending = new Set(subscriptionState.pendingSeqs);
  let highestSeenSeq = subscriptionState.highestSeenSeq;

  for (const event of events) {
    if (highestSeenSeq === undefined || event.seq > highestSeenSeq) {
      highestSeenSeq = event.seq;
    }

    // Skip stale events (already below reconciler high-water for this turn).
    if (isStaleEvent(event, subscriptionState.reconcilerState)) continue;

    if (consumedSeqs.has(event.seq)) {
      // Consumed — remove from pending (may have been pending from a prior pass).
      nextPending.delete(event.seq);
    } else {
      // Ignored conditional — add to pending so the frontier cannot skip it.
      nextPending.add(event.seq);
    }
  }

  const nextHighestSeen = highestSeenSeq;

  // Advance the contiguous resume cursor through non-pending seqs.
  const serverResumeSeq = computeContiguousResume(
    subscriptionState.serverResumeSeq,
    nextPending,
    nextHighestSeen,
  );

  return {
    reconcilerState: nextReconcilerState,
    serverResumeSeq,
    pendingSeqs: nextPending,
    highestSeenSeq: nextHighestSeen,
  };
}

// ─── Post-merge sealing ─────────────────────────────────────────────────────

/**
 * Seal terminal turns in the subscription's reconciler state after an
 * authoritative REST history merge. Callers of `conversation/merge-history`
 * must also call this so `isStaleEvent` rejects post-reconnect replays
 * targeting turns REST has already finalized.
 */
export function sealSubscriptionAfterMerge(
  stateMap: Map<string, StreamSubscriptionState>,
  conversationId: string,
  authoritativeEntries: readonly TranscriptEntryState[],
): void {
  const current = stateMap.get(conversationId) ?? createStreamSubscriptionState();
  const sealedReconciler = sealAuthoritativeTurns(current.reconcilerState, authoritativeEntries);
  if (sealedReconciler === current.reconcilerState) return;
  stateMap.set(conversationId, { ...current, reconcilerState: sealedReconciler });
}

// ─── Callback builder ───────────────────────────────────────────────────────

/** Lifecycle hooks consumed by the stream callback builder. */
export interface StreamLifecycleHooks {
  /** Invoked when the socket closes unexpectedly and reconnect should be attempted. */
  readonly onReconnectNeeded: () => void;
  /** Invoked when the WebSocket connection opens successfully. */
  readonly onConnectionEstablished: () => void;
  /** Invoked when a live approval prompt is consumed into the transcript. */
  readonly onApprovalPromptObserved?: (conversationId: string, event: StreamEvent) => void;
}

/**
 * Seed the resume cursor from the server-confirmed subscription baseline.
 *
 * On reconnect the server sends replayed stream-events *before* the
 * subscribed ack.  If those replayed events created pending gaps we must
 * NOT jump the cursor past the gaps — otherwise the pending seqs would be
 * skipped on the next reconnect.  Uses the contiguous frontier computation
 * in that case so gaps continue to block.
 */
function seedSubscriptionBaseline(
  stateMap: Map<string, StreamSubscriptionState>,
  conversationId: string,
  currentSeq: number,
): void {
  const currentState = stateMap.get(conversationId) ?? createStreamSubscriptionState();

  if (currentState.pendingSeqs.size > 0) {
    // Replay events already created gaps — respect them.
    const highestSeen =
      currentState.highestSeenSeq === undefined
        ? currentSeq
        : Math.max(currentState.highestSeenSeq, currentSeq);
    const safeFrontier = computeContiguousResume(
      currentState.serverResumeSeq,
      currentState.pendingSeqs,
      highestSeen,
    );
    stateMap.set(conversationId, {
      ...currentState,
      serverResumeSeq: safeFrontier ?? currentState.serverResumeSeq,
      highestSeenSeq: highestSeen,
    });
    return;
  }

  // No pending gaps — safe to seed / advance from server baseline.
  const seeded =
    currentState.serverResumeSeq === undefined
      ? currentSeq
      : Math.max(currentState.serverResumeSeq, currentSeq);
  stateMap.set(conversationId, { ...currentState, serverResumeSeq: seeded });
}

/**
 * Build StreamClient callbacks that route events into the workspace store.
 *
 * Per-conversation reconciler state is stored in `stateMap` so it survives
 * conversation switches and reconnects. Each processed event is acknowledged
 * via the provided `ack` function for server-side buffer cleanup.
 *
 * The reconnect resume cursor (`serverResumeSeq`) is only advanced after a
 * successful ack send. If ack throws, the reconciler and pending state are
 * updated locally (for dedup and rendering) but the resume cursor stays at
 * its previous value so reconnect replays from a safe position.
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
      const candidateState = applyStreamEventsToConversation(
        store,
        conversationId,
        [event],
        currentState,
      );

      // Detect whether this event was newly consumed (not pending, not stale).
      const wasConsumed =
        !candidateState.pendingSeqs.has(event.seq) &&
        !isStaleEvent(event, currentState.reconcilerState);

      if (wasConsumed) {
        // Only advance serverResumeSeq after successful ack.
        try {
          ack(conversationId, event.seq);
          // Ack succeeded — commit the full candidate state (resume cursor advanced).
          stateMap.set(conversationId, candidateState);
        } catch (err: unknown) {
          // Ack failed — keep reconciler + pendingSeqs but revert resume cursor.
          stateMap.set(conversationId, {
            ...candidateState,
            serverResumeSeq: currentState.serverResumeSeq,
          });
          console.warn(
            `[stream] Failed to ack seq ${String(event.seq)} for ${conversationId}:`,
            err,
          );
        }
      } else {
        // Event was pending (ignored conditional) or stale — update local state, no ack.
        stateMap.set(conversationId, candidateState);
      }

      if (wasConsumed && event.kind === 'approval-prompt') {
        lifecycle.onApprovalPromptObserved?.(conversationId, event);
      }
    },
    onOpen() {
      store.dispatch({
        type: 'connection/merge',
        patch: { transportStatus: 'live', reconnectAttempt: 0 },
      });
      lifecycle.onConnectionEstablished();
    },
    onClose(code) {
      store.dispatch({
        type: 'connection/merge',
        patch: {
          transportStatus: 'disconnected',
          lastDisconnectedAt: new Date().toISOString(),
        },
      });
      // Attempt reconnect for server-initiated or abnormal close.
      // Normal close (1000) means intentional shutdown — no reconnect.
      if (code !== 1000) {
        lifecycle.onReconnectNeeded();
      }
    },
    onSocketError() {
      store.dispatch({ type: 'connection/merge', patch: { transportStatus: 'reconnecting' } });
    },
    onSubscribed(conversationId, currentSeq) {
      seedSubscriptionBaseline(stateMap, conversationId, currentSeq);
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
