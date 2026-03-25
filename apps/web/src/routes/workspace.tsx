import type { ApprovalRequest, Conversation, StreamEvent, Turn } from '@hydra/web-contracts';
import {
  type Dispatch,
  useCallback,
  useEffect,
  useMemo,
  type RefObject,
  useReducer,
  useRef,
  type SetStateAction,
  useState,
  useSyncExternalStore,
  type JSX,
} from 'react';
import { WorkspaceLayout } from '../features/chat-workspace/components/workspace-layout.tsx';
import { ComposerPanel } from '../features/chat-workspace/components/composer-panel.tsx';
import {
  ConnectionBanner,
  ConnectionStateContext,
} from '../features/chat-workspace/components/connection-banner.tsx';
import {
  GatewayRequestError,
  createGatewayClient,
} from '../features/chat-workspace/api/gateway-client.ts';
import type { GatewayClient } from '../features/chat-workspace/api/gateway-client.ts';
import {
  createStreamClient,
  type StreamClient,
  type StreamClientCallbacks,
} from '../features/chat-workspace/api/stream-client.ts';
import {
  buildStreamCallbacks,
  type ContentBlockState,
  createAndSubmitDraft,
  createWorkspaceStore,
  type ArtifactViewState,
  type PromptViewState,
  submitComposerDraft,
  type DraftSubmitState,
  type StreamSubscriptionState,
  type TranscriptEntryState,
  type WorkspaceConversationRecord,
  type WorkspaceState,
  type WorkspaceStore,
} from '../features/chat-workspace/model/workspace-store.ts';
import { mergeAuthoritativeEntries } from '../features/chat-workspace/model/reconciler.ts';
import { sealSubscriptionAfterMerge } from '../features/chat-workspace/model/stream-subscription.ts';
import {
  pickBestApprovalPerTurn,
  selectHydratedApprovalPrompt,
} from '../features/chat-workspace/model/approval-selection.ts';
import { claimApprovalHydrationRetry } from '../features/chat-workspace/model/approval-hydration-retries.ts';
import {
  DEFAULT_VISIBLE_WINDOW,
  selectActiveConversation,
  selectActiveDraft,
  selectActiveLoadState,
  selectCanSubmit,
  selectConversationList,
  selectCreateModeCanSubmit,
  selectRecentEntries,
  selectTranscriptSummary,
  selectVisibleArtifact,
  precomputeTranscriptActions,
  NO_ACTION_FLAGS,
  type EntryActionFlags,
} from '../features/chat-workspace/model/selectors.ts';
import {
  resolveResponseLabel,
  respondToPrompt,
} from '../features/chat-workspace/model/prompt-helpers.ts';
import { canSubmitWork, describeConnectionState } from '../shared/session-state.ts';
import {
  hydrateConversationArtifacts,
  fetchArtifactContent,
} from '../features/chat-workspace/model/artifact-hydration.ts';
import {
  createInitialOperationsState,
  reduceOperationsState,
} from '../features/operations-panels/model/operations-reducer.ts';
import {
  selectAvailability as selectOpsAvailability,
  selectFilteredQueueItems,
  selectFreshness as selectOpsFreshness,
  selectHasPendingControl,
  selectSelectedWorkItemId,
  selectSnapshotStatus as selectOpsSnapshotStatus,
} from '../features/operations-panels/model/selectors.ts';
import { OperationsPanelShell } from '../features/operations-panels/components/operations-panel-shell.tsx';
import { QueuePanel } from '../features/operations-panels/components/queue-panel.tsx';

function useWorkspaceState(store: WorkspaceStore) {
  return useSyncExternalStore(
    (onStoreChange) =>
      store.subscribe(() => {
        onStoreChange();
      }),
    () => store.getState(),
    () => store.getState(),
  );
}

function shouldRetryApprovalHydration(err: unknown): boolean {
  if (err instanceof TypeError) {
    return true;
  }

  if (!(err instanceof GatewayRequestError)) {
    return false;
  }

  return err.status >= 500 || err.gatewayError.category === 'daemon';
}

async function loadPendingApprovalsForTranscript(
  client: GatewayClient,
  conversationId: string,
  onFailure: (err: unknown) => void,
): Promise<readonly ApprovalRequest[] | null> {
  try {
    const response = await client.getPendingApprovals(conversationId);
    return response.approvals;
  } catch (err: unknown) {
    console.warn(
      `[useTranscriptLoader] Failed to load pending approvals for conversation ${conversationId}:`,
      err,
    );
    onFailure(err);
    return null;
  }
}

function applyTranscriptLoadResult(
  store: WorkspaceStore,
  conversationId: string,
  response: Awaited<ReturnType<GatewayClient['loadHistory']>> | null,
  pendingApprovals: readonly ApprovalRequest[] | null,
): void {
  if (response != null) {
    // If streaming already populated the transcript (setting loadState to
    // 'ready') while the REST call was in flight, merge history with
    // stream-owned entries instead of skipping entirely. This preserves
    // authoritative older history AND any live stream entries.
    store.dispatch({
      type: 'conversation/merge-history',
      conversationId,
      entries: applyPendingApprovalsToEntries(
        response.turns.map(toTranscriptEntry),
        pendingApprovals ?? [],
      ),
      hasMoreHistory: response.hasMore,
    });
    return;
  }

  if (pendingApprovals == null) {
    return;
  }

  const current = store.getState().conversations.get(conversationId);
  if (current == null) {
    return;
  }

  store.dispatch({
    type: 'conversation/replace-entries',
    conversationId,
    entries: applyPendingApprovalsToEntries(current.entries, pendingApprovals),
    hasMoreHistory: current.hasMoreHistory,
  });
}

function markTranscriptLoadError(
  store: WorkspaceStore,
  conversationId: string,
  err: unknown,
): void {
  console.error(
    `[useTranscriptLoader] Failed to load transcript for conversation ${conversationId}:`,
    err,
  );

  store.dispatch({
    type: 'conversation/set-load-state',
    conversationId,
    loadState: 'error',
  });
}

function createTranscriptLoaderEffect(
  store: WorkspaceStore,
  client: GatewayClient,
  activeConversationId: string | null,
  approvalRetryCountsRef: RefObject<Map<string, number>>,
  setRetryNonce: Dispatch<SetStateAction<number>>,
  sealAfterMerge: SealAfterMergeFn,
): () => void {
  if (activeConversationId == null) {
    store.dispatch({ type: 'connection/merge', patch: { syncStatus: 'idle' } });
    return () => {};
  }

  const conversationId = activeConversationId;
  const existing = store.getState().conversations.get(conversationId);
  const shouldLoadHistory = existing?.historyLoaded !== true;
  if (!shouldLoadHistory) {
    store.dispatch({ type: 'connection/merge', patch: { syncStatus: 'idle' } });
  }

  const lifecycle = { disposed: false };
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleApprovalRetry = (err: unknown) => {
    if (lifecycle.disposed || retryTimer != null || !shouldRetryApprovalHydration(err)) {
      return;
    }

    if (!claimApprovalHydrationRetry(approvalRetryCountsRef.current, conversationId)) {
      return;
    }
    retryTimer = setTimeout(() => {
      setRetryNonce((value) => value + 1);
    }, APPROVAL_RETRY_DELAY_MS);
  };

  void (async () => {
    if (shouldLoadHistory) {
      store.dispatch({ type: 'connection/merge', patch: { syncStatus: 'syncing' } });
      store.dispatch({
        type: 'conversation/set-load-state',
        conversationId,
        loadState: 'loading',
      });
    }

    try {
      const [response, pendingApprovals] = await Promise.all([
        shouldLoadHistory
          ? client.loadHistory(conversationId, { limit: 50 })
          : Promise.resolve(null),
        loadPendingApprovalsForTranscript(client, conversationId, scheduleApprovalRetry),
      ]);
      if (lifecycle.disposed) {
        return;
      }

      applyTranscriptLoadResult(store, conversationId, response, pendingApprovals);
      if (response != null) {
        store.dispatch({
          type: 'connection/merge',
          patch: {
            syncStatus:
              store.getState().connection.transportStatus === 'live' ? 'recovered' : 'idle',
          },
        });
        sealAfterMerge(conversationId, response.turns.map(toTranscriptEntry));
      }

      if (pendingApprovals != null) {
        approvalRetryCountsRef.current.delete(conversationId);
      }
    } catch (err: unknown) {
      if (lifecycle.disposed) {
        return;
      }

      markTranscriptLoadError(store, conversationId, err);
      store.dispatch({ type: 'connection/merge', patch: { syncStatus: 'error' } });
    }
  })();

  return () => {
    lifecycle.disposed = true;
    if (retryTimer != null) {
      clearTimeout(retryTimer);
    }
  };
}

// ─── Stream subscription hook ───────────────────────────────────────────────

const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const RECONNECT_MAX_ATTEMPTS = 10;
const APPROVAL_RETRY_DELAY_MS = 1_000;

export interface StreamSubscriptionDeps {
  readonly store: WorkspaceStore;
  readonly streamClient: StreamClient;
  readonly client: GatewayClient;
  readonly activeConversationId: string | null;
}

/**
 * Manages the StreamClient lifecycle scoped to the active conversation.
 *
 * - Connects the WebSocket on mount, closes on unmount.
 * - Subscribes to the active conversation with resume capability
 *   (passes lastAcknowledgedSeq to replay missed events).
 * - Per-conversation reconciler state persists across conversation switches.
 * - Acknowledges processed events for server-side buffer cleanup.
 * - Reconnects with exponential backoff on unexpected socket close.
 */
export type SealAfterMergeFn = (
  conversationId: string,
  entries: readonly TranscriptEntryState[],
) => void;

// eslint-disable-next-line max-lines-per-function
function useStreamSubscription({
  store,
  streamClient,
  client,
  activeConversationId,
}: StreamSubscriptionDeps): SealAfterMergeFn {
  // Per-conversation reconciler + seq state — survives conversation switches
  const stateMapRef = useRef<Map<string, StreamSubscriptionState>>(new Map());
  const activeIdRef = useRef<string | null>(null);
  const intentionalCloseRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const callbacksRef = useRef<StreamClientCallbacks | null>(null);
  // Tracks a conversation that needs subscribing after the socket failed to
  // send (CLOSING/CLOSED). Fulfilled on the next successful open/reconnect.
  const pendingSubscribeRef = useRef<string | null>(null);
  const approvalHydrationInFlightRef = useRef(new Set<string>());
  const approvalHydrationRetryTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const approvalHydrationRetryCountsRef = useRef(new Map<string, number>());

  // Connect / disconnect lifecycle
  // eslint-disable-next-line max-lines-per-function
  useEffect(() => {
    intentionalCloseRef.current = false;
    const lifecycle = { disposed: false };

    function clearReconnectTimer(): void {
      if (reconnectTimerRef.current != null) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    }

    function clearApprovalHydrationRetry(key: string): void {
      const timer = approvalHydrationRetryTimersRef.current.get(key);
      if (timer != null) {
        clearTimeout(timer);
        approvalHydrationRetryTimersRef.current.delete(key);
      }
    }

    function scheduleApprovalHydrationRetry(
      conversationId: string,
      approvalId: string,
      event: StreamEvent,
    ): void {
      if (lifecycle.disposed) {
        return;
      }
      const key = `${conversationId}:${approvalId}`;
      if (approvalHydrationRetryTimersRef.current.has(key)) {
        return;
      }

      if (!claimApprovalHydrationRetry(approvalHydrationRetryCountsRef.current, key)) {
        return;
      }
      approvalHydrationRetryTimersRef.current.set(
        key,
        setTimeout(() => {
          approvalHydrationRetryTimersRef.current.delete(key);
          hydrateLiveApprovalPrompt(conversationId, event);
        }, APPROVAL_RETRY_DELAY_MS),
      );
    }

    function hydrateLiveApprovalPrompt(conversationId: string, event: StreamEvent): void {
      if (lifecycle.disposed) {
        return;
      }
      const approvalId =
        typeof event.payload['approvalId'] === 'string' ? event.payload['approvalId'] : null;
      if (approvalId == null || approvalId === '') {
        return;
      }

      const key = `${conversationId}:${approvalId}`;
      if (approvalHydrationInFlightRef.current.has(key)) {
        return;
      }
      approvalHydrationInFlightRef.current.add(key);

      void (async () => {
        try {
          const response = await client.getPendingApprovals(conversationId);
          if (lifecycle.disposed) {
            return;
          }
          const approval = response.approvals.find((candidate) => candidate.id === approvalId);
          if (approval == null) {
            scheduleApprovalHydrationRetry(conversationId, approvalId, event);
            return;
          }

          store.dispatch({
            type: 'prompt/hydrate',
            conversationId,
            turnId: approval.turnId,
            promptId: approval.id,
            allowedResponses: approval.responseOptions.map((option) => ({
              key: option.key,
              label: option.label,
            })),
            contextBlocks: toPromptContextBlocks(approval),
          });
          clearApprovalHydrationRetry(key);
          approvalHydrationRetryCountsRef.current.delete(key);
        } catch (err: unknown) {
          if (lifecycle.disposed) {
            return;
          }
          console.warn(
            `[stream] Failed to hydrate approval prompt ${approvalId} for ${conversationId}:`,
            err,
          );
          if (shouldRetryApprovalHydration(err)) {
            scheduleApprovalHydrationRetry(conversationId, approvalId, event);
          }
        } finally {
          approvalHydrationInFlightRef.current.delete(key);
        }
      })();
    }

    function scheduleReconnect(): void {
      clearReconnectTimer();

      if (reconnectAttemptRef.current >= RECONNECT_MAX_ATTEMPTS) {
        store.dispatch({
          type: 'connection/merge',
          patch: {
            transportStatus: 'disconnected',
            reconnectAttempt: reconnectAttemptRef.current,
          },
        });
        console.warn('[stream] Max reconnect attempts reached');
        return;
      }

      const delay = Math.min(
        RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttemptRef.current,
        RECONNECT_MAX_DELAY_MS,
      );
      reconnectAttemptRef.current += 1;

      store.dispatch({
        type: 'connection/merge',
        patch: {
          transportStatus: 'reconnecting',
          reconnectAttempt: reconnectAttemptRef.current,
        },
      });

      reconnectTimerRef.current = setTimeout(() => {
        const cbs = callbacksRef.current;
        if (cbs == null) return;

        try {
          streamClient.connect(cbs);

          const activeId = activeIdRef.current;
          if (activeId != null) {
            const convState = stateMapRef.current.get(activeId);
            streamClient.subscribe(activeId, convState?.serverResumeSeq);
            pendingSubscribeRef.current = null;
          }
        } catch (err: unknown) {
          console.warn('[stream] Reconnect attempt failed:', err);
          scheduleReconnect();
        }
      }, delay);
    }

    const callbacks = buildStreamCallbacks(
      store,
      stateMapRef.current,
      (conversationId, seq) => {
        streamClient.ack(conversationId, seq);
      },
      {
        onReconnectNeeded() {
          if (!intentionalCloseRef.current) {
            scheduleReconnect();
          }
        },
        onConnectionEstablished() {
          reconnectAttemptRef.current = 0;
          clearReconnectTimer();

          // Fulfill deferred subscription from a prior effect-level failure.
          const pendingId = pendingSubscribeRef.current;
          if (pendingId != null && pendingId === activeIdRef.current) {
            pendingSubscribeRef.current = null;
            const convState = stateMapRef.current.get(pendingId);
            try {
              streamClient.subscribe(pendingId, convState?.serverResumeSeq);
            } catch {
              // Still not writable — will retry on next reconnect.
              pendingSubscribeRef.current = pendingId;
            }
          }
        },
        onApprovalPromptObserved(conversationId, event) {
          hydrateLiveApprovalPrompt(conversationId, event);
        },
      },
    );

    callbacksRef.current = callbacks;
    streamClient.connect(callbacks);

    return () => {
      lifecycle.disposed = true;
      intentionalCloseRef.current = true;
      clearReconnectTimer();
      for (const timer of approvalHydrationRetryTimersRef.current.values()) {
        clearTimeout(timer);
      }
      approvalHydrationRetryTimersRef.current.clear();
      approvalHydrationRetryCountsRef.current.clear();
      callbacksRef.current = null;
      streamClient.close();
    };
  }, [store, streamClient]);

  // Subscribe / unsubscribe scoped to active conversation
  useEffect(() => {
    activeIdRef.current = activeConversationId;

    if (activeConversationId != null) {
      const convState = stateMapRef.current.get(activeConversationId);
      try {
        streamClient.subscribe(activeConversationId, convState?.serverResumeSeq);
        pendingSubscribeRef.current = null;
      } catch (_err: unknown) {
        // Socket not writable — store the intent for the next open/reconnect.
        pendingSubscribeRef.current = activeConversationId;
        console.warn(
          `[stream] Subscribe deferred for ${activeConversationId} — will retry on next open`,
        );
      }
    }

    return () => {
      if (activeConversationId != null) {
        pendingSubscribeRef.current = null;
        try {
          streamClient.unsubscribe(activeConversationId);
        } catch (err: unknown) {
          console.warn(`[stream] Cleanup unsubscribe failed for ${activeConversationId}:`, err);
        }
      }
    };
  }, [activeConversationId, streamClient]);

  // Expose the subscription stateMap so the transcript loader can seal turns
  // after authoritative REST merges — prevents post-reconnect replays from
  // mutating REST-finalized turns.
  return useCallback((conversationId: string, entries: readonly TranscriptEntryState[]) => {
    sealSubscriptionAfterMerge(stateMapRef.current, conversationId, entries);
  }, []);
}

function toWorkspaceConversationRecord(conversation: Conversation): WorkspaceConversationRecord {
  return {
    id: conversation.id,
    title: conversation.title,
    status: conversation.status,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    turnCount: conversation.turnCount,
    pendingInstructionCount: conversation.pendingInstructionCount,
    parentConversationId: conversation.parentConversationId,
    forkPointTurnId: conversation.forkPointTurnId,
  };
}

function toContentBlocks(turn: Turn): readonly ContentBlockState[] {
  const blocks: ContentBlockState[] = [];

  if (turn.instruction != null && turn.instruction !== '') {
    blocks.push({
      blockId: `${turn.id}-instruction`,
      kind: 'text',
      text: turn.instruction,
      metadata: null,
    });
  }

  if (turn.response != null && turn.response !== '') {
    blocks.push({
      blockId: `${turn.id}-response`,
      kind: 'text',
      text: turn.response,
      metadata: null,
    });
  }

  return blocks;
}

function toTranscriptEntry(turn: Turn): TranscriptEntryState {
  return {
    entryId: turn.id,
    kind: 'turn',
    turnId: turn.id,
    attributionLabel: turn.attribution.label,
    status: turn.status,
    timestamp: turn.completedAt ?? turn.createdAt,
    lineageSummary:
      turn.parentTurnId == null
        ? null
        : {
            sourceConversationId: null,
            sourceTurnId: turn.parentTurnId,
            relationshipKind: 'retry',
          },
    contentBlocks: toContentBlocks(turn),
    artifacts: [],
    controls: [],
    prompt: null,
  };
}

function toPromptContextBlocks(approval: ApprovalRequest): readonly ContentBlockState[] {
  const blocks: ContentBlockState[] = [
    {
      blockId: `${approval.id}-prompt`,
      kind: 'text',
      text: approval.prompt,
      metadata: null,
    },
  ];

  if (Object.keys(approval.context).length > 0) {
    blocks.push({
      blockId: `${approval.id}-context`,
      kind: 'structured',
      text: JSON.stringify(approval.context, null, 2),
      metadata: null,
    });
  }

  return blocks;
}

function approvalStatusToPromptStatus(
  status: ApprovalRequest['status'],
): TranscriptEntryState['prompt'] extends infer T
  ? T extends { status: infer S }
    ? S
    : never
  : never {
  switch (status) {
    case 'responded':
      return 'resolved';
    case 'stale':
      return 'stale';
    case 'expired':
      return 'unavailable';
    case 'pending':
      return 'pending';
  }
}

function applyPendingApprovalsToEntries(
  entries: readonly TranscriptEntryState[],
  approvals: readonly ApprovalRequest[],
): readonly TranscriptEntryState[] {
  if (approvals.length === 0) {
    return entries;
  }

  const approvalsByTurnId = pickBestApprovalPerTurn(approvals);
  return entries.map((entry) => {
    if (entry.kind !== 'turn' || entry.turnId == null) {
      return entry;
    }

    const approval = approvalsByTurnId.get(entry.turnId);
    if (approval == null) {
      return entry;
    }

    const restPrompt: PromptViewState = {
      promptId: approval.id,
      parentTurnId: approval.turnId,
      status: approvalStatusToPromptStatus(approval.status),
      allowedResponses: approval.responseOptions.map((option) => ({
        key: option.key,
        label: option.label,
      })),
      contextBlocks: toPromptContextBlocks(approval),
      lastResponseSummary:
        approval.response == null
          ? null
          : resolveResponseLabel(
              approval.responseOptions.map((o) => ({ key: o.key, label: o.label })),
              approval.response,
            ),
      errorMessage: null,
      staleReason: null,
    };

    return {
      ...entry,
      prompt: selectHydratedApprovalPrompt(entry.prompt, restPrompt),
    };
  });
}

function resolveComposerSubmitState(
  isCreateMode: boolean,
  draftSubmitState: DraftSubmitState | undefined,
  createSubmitting: boolean,
  createError: string | null,
): DraftSubmitState {
  if (!isCreateMode) {
    return draftSubmitState ?? 'idle';
  }

  if (createSubmitting) {
    return 'submitting';
  }

  if (createError != null) {
    return 'error';
  }

  return 'idle';
}

function resolveComposerPolicyLabel(
  isLoadingConversations: boolean,
  connectionCanSubmit: boolean,
  state: WorkspaceState,
  activeConversation:
    | {
        readonly controlState: {
          readonly submissionPolicyLabel: string;
        };
      }
    | undefined,
): string {
  if (isLoadingConversations) {
    return 'Loading conversations…';
  }

  if (!connectionCanSubmit) {
    return describeConnectionState(state.connection);
  }

  return activeConversation?.controlState.submissionPolicyLabel ?? 'Ready for operator input';
}

function resolveComposerCanSubmit(
  isCreateMode: boolean,
  isLoadingConversations: boolean,
  connectionCanSubmit: boolean,
  continueCanSubmit: boolean,
  createCanSubmit: boolean,
): boolean {
  if (isLoadingConversations && !isCreateMode) {
    return false;
  }

  const draftCanSubmit = isCreateMode ? createCanSubmit : continueCanSubmit;
  return connectionCanSubmit && draftCanSubmit;
}

function useConversationListLoader(store: WorkspaceStore, client: GatewayClient) {
  const [isLoadingConversations, setIsLoadingConversations] = useState(true);
  const [conversationErrorMessage, setConversationErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;

    async function loadConversations(): Promise<void> {
      setIsLoadingConversations(true);
      setConversationErrorMessage(null);

      try {
        const response = await client.listConversations({ status: 'active', limit: 20 });
        if (disposed) {
          return;
        }

        store.dispatch({
          type: 'conversation/replace-all',
          conversations: response.conversations.map(toWorkspaceConversationRecord),
        });
      } catch (err) {
        if (disposed) {
          return;
        }

        setConversationErrorMessage(
          err instanceof Error ? err.message : 'Unable to load conversations.',
        );
      } finally {
        if (!disposed) {
          setIsLoadingConversations(false);
        }
      }
    }

    void loadConversations();
    return () => {
      disposed = true;
    };
  }, [client, store]);

  const reloadConversationList = useCallback(async () => {
    try {
      const response = await client.listConversations({ status: 'active', limit: 20 });
      store.dispatch({
        type: 'conversation/replace-all',
        conversations: response.conversations.map(toWorkspaceConversationRecord),
      });
      setConversationErrorMessage(null);
    } catch (err: unknown) {
      console.warn('[reloadConversationList] Background refresh failed:', err);
    }
  }, [client, store]);

  return {
    isLoadingConversations,
    conversationErrorMessage,
    clearConversationError: useCallback(() => {
      setConversationErrorMessage(null);
    }, []),
    reloadConversationList,
  };
}

function useTranscriptLoader(
  store: WorkspaceStore,
  client: GatewayClient,
  activeConversationId: string | null,
  sealAfterMerge: SealAfterMergeFn,
) {
  const [retryNonce, setRetryNonce] = useState(0);
  const approvalRetryCountsRef = useRef(new Map<string, number>());

  useEffect(
    () =>
      createTranscriptLoaderEffect(
        store,
        client,
        activeConversationId,
        approvalRetryCountsRef,
        setRetryNonce,
        sealAfterMerge,
      ),
    [activeConversationId, client, retryNonce, sealAfterMerge, store],
  );

  return useCallback(() => {
    setRetryNonce((value) => value + 1);
  }, []);
}

function clearFollowUpPolicyLabel(store: WorkspaceStore, conversationId: string): void {
  const conversation = store.getState().conversations.get(conversationId);
  if (conversation == null) {
    return;
  }

  if (!conversation.controlState.submissionPolicyLabel.startsWith('Follow-up to turn ')) {
    return;
  }

  store.dispatch({
    type: 'conversation/update-control-state',
    conversationId,
    patch: { submissionPolicyLabel: 'Ready for operator input' },
  });
}

// eslint-disable-next-line max-lines-per-function
function useComposerProps(
  store: WorkspaceStore,
  client: GatewayClient,
  state: WorkspaceState,
  isLoadingConversations: boolean,
  clearConversationError: () => void,
  reloadConversationList: () => Promise<void>,
) {
  const [createDraftText, setCreateDraftText] = useState('');
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const isCreateMode = !isLoadingConversations && state.activeConversationId == null;
  const draft = selectActiveDraft(state);
  const activeConversation = selectActiveConversation(state);
  const connectionCanSubmit = canSubmitWork(state.connection);
  const continueCanSubmit = selectCanSubmit(state);
  const createCanSubmit = selectCreateModeCanSubmit(createDraftText, createSubmitting, createError);

  const handleDraftChange = useCallback(
    (text: string) => {
      const currentId = store.getState().activeConversationId;
      if (currentId == null) {
        if (isLoadingConversations) {
          return;
        }
        setCreateDraftText(text);
        setCreateError(null);
        return;
      }

      store.dispatch({ type: 'draft/set-text', conversationId: currentId, draftText: text });
    },
    [isLoadingConversations, store],
  );

  const handleSubmit = useCallback(() => {
    const currentId = store.getState().activeConversationId;
    if (currentId == null) {
      if (isLoadingConversations) {
        return;
      }

      setCreateSubmitting(true);
      setCreateError(null);
      void createAndSubmitDraft({ store, client }, createDraftText)
        .then((result) => {
          if (result.ok) {
            setCreateDraftText('');
            clearConversationError();
            void reloadConversationList();
          }
        })
        .catch((err: unknown) => {
          setCreateError(err instanceof Error ? err.message : 'Failed to create conversation');
        })
        .finally(() => {
          setCreateSubmitting(false);
        });
      return;
    }

    void submitComposerDraft({ store, client }).then((result) => {
      if (result.ok) {
        clearFollowUpPolicyLabel(store, currentId);
        void reloadConversationList();
      }
    });
  }, [
    clearConversationError,
    client,
    createDraftText,
    isLoadingConversations,
    reloadConversationList,
    store,
  ]);

  const policyLabel = resolveComposerPolicyLabel(
    isLoadingConversations,
    connectionCanSubmit,
    state,
    activeConversation,
  );
  const canSubmit = resolveComposerCanSubmit(
    isCreateMode,
    isLoadingConversations,
    connectionCanSubmit,
    continueCanSubmit,
    createCanSubmit,
  );

  return {
    draftText: isCreateMode ? createDraftText : (draft?.draftText ?? ''),
    submitState: resolveComposerSubmitState(
      isCreateMode,
      draft?.submitState,
      createSubmitting,
      createError,
    ),
    validationMessage: isCreateMode ? createError : (draft?.validationMessage ?? null),
    canSubmit,
    policyLabel,
    disabled: isLoadingConversations && state.activeConversationId == null,
    activeConversation,
    onDraftChange: handleDraftChange,
    onSubmit: handleSubmit,
    clearCreateState: () => {
      setCreateError(null);
      setCreateDraftText('');
      setCreateSubmitting(false);
    },
  };
}

function usePromptResponder(store: WorkspaceStore, client: GatewayClient) {
  return useCallback(
    (promptId: string, response: string) => {
      const currentState = store.getState();
      const conversationId = currentState.activeConversationId;
      if (conversationId == null) return;

      const conv = currentState.conversations.get(conversationId);
      const entry = conv?.entries.find((e) => e.prompt?.promptId === promptId);
      const turnId = entry?.turnId;
      if (turnId == null) return;

      void respondToPrompt({ store, client }, { conversationId, turnId, promptId, response });
    },
    [store, client],
  );
}

// ─── Turn control helpers ───────────────────────────────────────────────────

/**
 * Immediately reconcile a single turn entry in the active transcript.
 * Replaces existing entry by turnId (cancel) or appends if new (retry).
 */
function reconcileTurnEntry(store: WorkspaceStore, conversationId: string, turn: Turn): void {
  const conv = store.getState().conversations.get(conversationId);
  if (conv == null) return;

  const entry = toTranscriptEntry(turn);
  const hasCanonicalTurn = conv.entries.some(
    (existing) => existing.kind === 'turn' && existing.turnId === entry.turnId,
  );
  const entries = hasCanonicalTurn
    ? conv.entries.map((existing) =>
        existing.kind === 'turn' && existing.turnId === entry.turnId ? entry : existing,
      )
    : [...conv.entries, entry];

  store.dispatch({
    type: 'conversation/replace-entries',
    conversationId,
    entries: mergeAuthoritativeEntries(entries, conv.entries),
    hasMoreHistory: conv.hasMoreHistory,
  });
}

/**
 * Full authoritative transcript reload from the server.
 * Fire-and-forget — failures are logged but do not propagate.
 */
async function reconcileActiveTranscript(
  client: GatewayClient,
  store: WorkspaceStore,
  conversationId: string,
  sealAfterMerge: SealAfterMergeFn,
): Promise<void> {
  try {
    const response = await client.loadHistory(conversationId, { limit: 50 });
    const entries = response.turns.map(toTranscriptEntry);
    store.dispatch({
      type: 'conversation/merge-history',
      conversationId,
      entries,
      hasMoreHistory: response.hasMore,
    });
    sealAfterMerge(conversationId, entries);
  } catch (err: unknown) {
    console.warn('[turn-action] Background transcript reconciliation failed:', err);
  }
}

// ─── Turn control action hooks ──────────────────────────────────────────────

// eslint-disable-next-line max-lines-per-function
function useTurnActions(
  store: WorkspaceStore,
  client: GatewayClient,
  reloadConversationList: () => Promise<void>,
  sealAfterMerge: SealAfterMergeFn,
  actionMap: ReadonlyMap<string, EntryActionFlags>,
) {
  const pendingTurnActionIdsRef = useRef<ReadonlySet<string>>(new Set());
  const [pendingTurnActionIds, setPendingTurnActionIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const tryMarkTurnActionPending = useCallback((turnId: string): boolean => {
    if (pendingTurnActionIdsRef.current.has(turnId)) {
      return false;
    }

    const nextPending = new Set(pendingTurnActionIdsRef.current);
    nextPending.add(turnId);
    pendingTurnActionIdsRef.current = nextPending;
    setPendingTurnActionIds(nextPending);
    return true;
  }, []);

  const clearTurnActionPending = useCallback((turnId: string): void => {
    if (!pendingTurnActionIdsRef.current.has(turnId)) {
      return;
    }

    const nextPending = new Set(pendingTurnActionIdsRef.current);
    nextPending.delete(turnId);
    pendingTurnActionIdsRef.current = nextPending;
    setPendingTurnActionIds(nextPending);
  }, []);

  const handleCancel = useCallback(
    (turnId: string) => {
      if (!tryMarkTurnActionPending(turnId)) {
        return;
      }

      const conversationId = store.getState().activeConversationId;
      if (conversationId == null) {
        clearTurnActionPending(turnId);
        return;
      }

      const prevControlState = store.getState().conversations.get(conversationId)?.controlState ?? {
        canSubmit: true,
        submissionPolicyLabel: 'Ready for operator input',
        staleReason: null,
      };

      store.dispatch({
        type: 'conversation/update-control-state',
        conversationId,
        patch: { canSubmit: false, submissionPolicyLabel: 'Cancelling…' },
      });

      void (async () => {
        try {
          const response = await client.cancelTurn(conversationId, turnId);

          // Immediately reconcile the cancelled turn from authoritative response
          reconcileTurnEntry(store, conversationId, response.turn);

          // Seal the cancelled turn now so late websocket frames are rejected
          // by isStaleEvent before the background reconcile finishes.
          sealAfterMerge(conversationId, [toTranscriptEntry(response.turn)]);

          // Full authoritative transcript reload in background
          void reconcileActiveTranscript(client, store, conversationId, sealAfterMerge);
          void reloadConversationList();

          // Derive post-cancel state: conversation is ready for new input
          store.dispatch({
            type: 'conversation/update-control-state',
            conversationId,
            patch: {
              canSubmit: true,
              submissionPolicyLabel: 'Ready for operator input',
              staleReason: null,
            },
          });
        } catch (err: unknown) {
          console.error('[turn-action] Cancel failed:', err);
          // Restore previous authoritative control state on failure
          store.dispatch({
            type: 'conversation/update-control-state',
            conversationId,
            patch: prevControlState,
          });
        } finally {
          clearTurnActionPending(turnId);
        }
      })();
    },
    [
      clearTurnActionPending,
      client,
      reloadConversationList,
      sealAfterMerge,
      store,
      tryMarkTurnActionPending,
    ],
  );

  const handleRetry = useCallback(
    (turnId: string) => {
      if (!tryMarkTurnActionPending(turnId)) {
        return;
      }

      const conversationId = store.getState().activeConversationId;
      if (conversationId == null) {
        clearTurnActionPending(turnId);
        return;
      }

      const prevControlState = store.getState().conversations.get(conversationId)?.controlState ?? {
        canSubmit: true,
        submissionPolicyLabel: 'Ready for operator input',
        staleReason: null,
      };

      store.dispatch({
        type: 'conversation/update-control-state',
        conversationId,
        patch: { canSubmit: false, submissionPolicyLabel: 'Retrying…' },
      });

      void (async () => {
        try {
          const response = await client.retryTurn(conversationId, turnId);

          // Immediately reconcile the new retry turn from authoritative response
          reconcileTurnEntry(store, conversationId, response.turn);

          // Full authoritative transcript reload in background
          void reconcileActiveTranscript(client, store, conversationId, sealAfterMerge);
          void reloadConversationList();

          // Derive post-retry state: conversation is ready for new input
          store.dispatch({
            type: 'conversation/update-control-state',
            conversationId,
            patch: {
              canSubmit: true,
              submissionPolicyLabel: 'Ready for operator input',
              staleReason: null,
            },
          });
        } catch (err: unknown) {
          console.error('[turn-action] Retry failed:', err);
          // Restore previous authoritative control state on failure
          store.dispatch({
            type: 'conversation/update-control-state',
            conversationId,
            patch: prevControlState,
          });
        } finally {
          clearTurnActionPending(turnId);
        }
      })();
    },
    [
      clearTurnActionPending,
      client,
      reloadConversationList,
      sealAfterMerge,
      store,
      tryMarkTurnActionPending,
    ],
  );

  const handleBranch = useCallback(
    (turnId: string) => {
      if (!tryMarkTurnActionPending(turnId)) {
        return;
      }

      const conversationId = store.getState().activeConversationId;
      if (conversationId == null) {
        clearTurnActionPending(turnId);
        return;
      }

      void (async () => {
        try {
          const result = await client.branchConversation(conversationId, turnId);
          // Select the newly created branch conversation
          store.dispatch({
            type: 'conversation/upsert',
            conversation: {
              id: result.id,
              title: result.title,
              status: result.status,
              createdAt: result.createdAt,
              updatedAt: result.updatedAt,
              parentConversationId: conversationId,
              forkPointTurnId: turnId,
            },
          });
          store.dispatch({
            type: 'conversation/select',
            conversationId: result.id,
          });
          void reloadConversationList();
        } catch (err: unknown) {
          console.error('[turn-action] Branch failed:', err);
        } finally {
          clearTurnActionPending(turnId);
        }
      })();
    },
    [clearTurnActionPending, client, reloadConversationList, store, tryMarkTurnActionPending],
  );

  const handleFollowUp = useCallback(
    (turnId: string) => {
      const conversationId = store.getState().activeConversationId;
      if (conversationId == null) return;

      // Surface follow-up context in the composer policy label
      store.dispatch({
        type: 'conversation/update-control-state',
        conversationId,
        patch: { submissionPolicyLabel: `Follow-up to turn ${turnId}` },
      });

      // Ensure the draft exists for this conversation (no-op if already present)
      store.dispatch({
        type: 'draft/set-text',
        conversationId,
        draftText: store.getState().drafts.get(conversationId)?.draftText ?? '',
      });

      // Focus the composer textarea programmatically
      queueMicrotask(() => {
        const composerEl = document.getElementById('composer-instruction');
        if (composerEl instanceof HTMLTextAreaElement) {
          if (typeof composerEl.scrollIntoView === 'function') {
            composerEl.scrollIntoView({ block: 'nearest' });
          }
          composerEl.focus();
          composerEl.setSelectionRange(composerEl.value.length, composerEl.value.length);
        }
      });
    },
    [store],
  );

  const resolveEntryActions = useCallback(
    (entry: { readonly turnId: string | null; readonly kind: string }): EntryActionFlags => {
      if (entry.kind !== 'turn' || entry.turnId == null) {
        return NO_ACTION_FLAGS;
      }

      if (pendingTurnActionIds.has(entry.turnId)) {
        return NO_ACTION_FLAGS;
      }

      return actionMap.get(entry.turnId) ?? NO_ACTION_FLAGS;
    },
    [actionMap, pendingTurnActionIds],
  );

  return {
    handleCancel,
    handleRetry,
    handleBranch,
    handleFollowUp,
    resolveEntryActions,
  };
}

// ─── Artifact hydration hook ────────────────────────────────────────────────

/**
 * Browser-side artifact hydration hook.
 *
 * After REST history load (where Turn payloads do not include artifacts),
 * hydrate artifact references by querying `listArtifactsForTurn` for each turn.
 * This makes artifacts discoverable after refresh/reopen, not only during live
 * streaming.
 *
 * Tracks hydration at the *turn* level rather than the conversation level so
 * that transient failures for individual turns do not permanently suppress
 * retries. Failed turns remain eligible for hydration on subsequent renders.
 */
// eslint-disable-next-line max-lines-per-function -- route-level hydration coordination
function useArtifactHydration(
  store: WorkspaceStore,
  client: GatewayClient,
  activeConversationId: string | null,
  entries: readonly TranscriptEntryState[],
): void {
  const hydratedTurnsByConversationRef = useRef(new Map<string, Set<string>>());
  const liveHydrationKeysByConversationRef = useRef(new Map<string, Map<string, string>>());
  const pendingTurnsByConversationRef = useRef(new Map<string, Set<string>>());
  const terminalFailuresByConversationRef = useRef(new Map<string, Set<string>>());
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  const buildLiveHydrationKey = (entry: TranscriptEntryState): string =>
    `${entry.status}:${String(entry.artifacts.length)}`;

  // eslint-disable-next-line max-lines-per-function -- hydration state machine spans retry/terminal/live cases
  useEffect(() => {
    if (activeConversationId == null) return;

    const conversation = store.getState().conversations.get(activeConversationId);
    if (conversation?.historyLoaded !== true) return;
    const hydratedTurns =
      hydratedTurnsByConversationRef.current.get(activeConversationId) ?? new Set<string>();
    const liveHydrationKeys =
      liveHydrationKeysByConversationRef.current.get(activeConversationId) ??
      new Map<string, string>();
    const pendingTurns =
      pendingTurnsByConversationRef.current.get(activeConversationId) ?? new Set<string>();
    const terminalFailures =
      terminalFailuresByConversationRef.current.get(activeConversationId) ?? new Set<string>();
    hydratedTurnsByConversationRef.current.set(activeConversationId, hydratedTurns);
    liveHydrationKeysByConversationRef.current.set(activeConversationId, liveHydrationKeys);
    pendingTurnsByConversationRef.current.set(activeConversationId, pendingTurns);
    terminalFailuresByConversationRef.current.set(activeConversationId, terminalFailures);

    // Collect turn entries that need artifact hydration — terminal turns are
    // hydrated once and then pinned in hydratedTurns, while live turns track a
    // lightweight status/artifact-count signature so refresh recovery can
    // backfill missed artifact notices without refetching on every text delta.
    const turnsToHydrate = entries.flatMap((entry) => {
      if (
        entry.kind !== 'turn' ||
        entry.turnId == null ||
        pendingTurns.has(entry.turnId) ||
        terminalFailures.has(entry.turnId)
      ) {
        return [];
      }

      const isTerminal =
        entry.status === 'completed' || entry.status === 'failed' || entry.status === 'cancelled';
      if (isTerminal) {
        return hydratedTurns.has(entry.turnId) ? [] : [{ turnId: entry.turnId, isTerminal: true }];
      }

      const liveHydrationKey = buildLiveHydrationKey(entry);
      return liveHydrationKeys.get(entry.turnId) === liveHydrationKey
        ? []
        : [{ turnId: entry.turnId, isTerminal: false }];
    });

    const turnIds = turnsToHydrate.map(({ turnId }) => turnId);
    const terminalTurnIds = new Set(
      turnsToHydrate.filter(({ isTerminal }) => isTerminal).map(({ turnId }) => turnId),
    );

    if (turnIds.length === 0) return;
    for (const turnId of turnIds) {
      pendingTurns.add(turnId);
    }

    const conversationId = activeConversationId;

    void hydrateConversationArtifacts(conversationId, turnIds, client, (action) => {
      store.dispatch(action);
    }).then(
      // eslint-disable-next-line complexity -- terminal/live success handling shares one coordination path
      ({ successfulTurns, retryableFailures, terminalFailures: nextTerminalFailures }) => {
        // Re-resolve per-conversation structures from refs so writes land in
        // the *current* Maps/Sets, not stale captures from before a potential
        // conversation switch (liveHydrationKeys is cleared on switch for
        // reopen-recovery; pendingTurns survives but may have been replaced).
        const resolvedPending = pendingTurnsByConversationRef.current.get(conversationId);
        const resolvedLiveKeys = liveHydrationKeysByConversationRef.current.get(conversationId);

        for (const turnId of turnIds) {
          resolvedPending?.delete(turnId);
        }
        for (const turnId of nextTerminalFailures) {
          terminalFailures.add(turnId);
          resolvedLiveKeys?.delete(turnId);
        }

        const latestEntries =
          store
            .getState()
            .conversations.get(conversationId)
            ?.entries.filter(
              (entry): entry is TranscriptEntryState =>
                entry.kind === 'turn' && entry.turnId != null,
            ) ?? [];
        const latestTurnsById = new Map(latestEntries.map((entry) => [entry.turnId, entry]));

        let shouldRecheckTerminalTurns = false;
        for (const turnId of successfulTurns) {
          const latestEntry = latestTurnsById.get(turnId);
          if (latestEntry == null) {
            resolvedLiveKeys?.delete(turnId);
            continue;
          }

          const isTerminal =
            latestEntry.status === 'completed' ||
            latestEntry.status === 'failed' ||
            latestEntry.status === 'cancelled';
          if (isTerminal) {
            resolvedLiveKeys?.delete(turnId);
            if (terminalTurnIds.has(turnId)) {
              hydratedTurns.add(turnId);
            } else {
              shouldRecheckTerminalTurns = true;
            }
          } else {
            resolvedLiveKeys?.set(turnId, buildLiveHydrationKey(latestEntry));
          }
        }

        if (
          shouldRecheckTerminalTurns &&
          retryTimerRef.current == null &&
          store.getState().activeConversationId === conversationId
        ) {
          setRetryNonce((value) => value + 1);
        }

        if (
          retryableFailures.size === 0 ||
          retryTimerRef.current != null ||
          store.getState().activeConversationId !== conversationId
        ) {
          return;
        }

        retryTimerRef.current = setTimeout(() => {
          retryTimerRef.current = null;
          if (store.getState().activeConversationId !== conversationId) {
            return;
          }
          setRetryNonce((value) => value + 1);
        }, 1_000);
      },
    );

    // No timer cleanup here — same-conversation rerenders (entries changing)
    // must not cancel a pending retry.  Conversation-switch and unmount
    // cleanup is handled by the dedicated effect below.
  }, [activeConversationId, client, entries, retryNonce, store]);

  // Clear the retry timer only when the active conversation changes or on
  // unmount — NOT on same-conversation rerenders that merely update entries.
  useEffect(
    () => () => {
      if (retryTimerRef.current != null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      if (activeConversationId != null) {
        liveHydrationKeysByConversationRef.current.delete(activeConversationId);
        // pendingTurns intentionally kept — in-flight hydration Promises still
        // reference this Set, and a quick switch-back must see turns as pending
        // to avoid issuing duplicate listArtifactsForTurn requests.
      }
    },
    [activeConversationId],
  );
}

// eslint-disable-next-line max-lines-per-function
export function WorkspaceRoute(): JSX.Element {
  const [store] = useState(() => createWorkspaceStore());
  const state = useWorkspaceState(store);
  const client = useMemo(() => createGatewayClient({ baseUrl: '' }), []);

  // Operations panels state (Phase 1 — UI shell, no polling yet)
  const [opsState, dispatchOps] = useReducer(
    reduceOperationsState,
    undefined,
    createInitialOperationsState,
  );

  const wsStreamClient = useMemo(
    () =>
      createStreamClient({
        baseUrl: `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`,
      }),
    [],
  );
  const {
    isLoadingConversations,
    conversationErrorMessage,
    clearConversationError,
    reloadConversationList,
  } = useConversationListLoader(store, client);

  // Wire live stream subscription scoped to active conversation.
  // Returns a seal callback used by the transcript loader to protect
  // REST-finalized turns from post-reconnect stream replays.
  const sealAfterMerge = useStreamSubscription({
    store,
    streamClient: wsStreamClient,
    client,
    activeConversationId: state.activeConversationId,
  });

  const retryActiveTranscript = useTranscriptLoader(
    store,
    client,
    state.activeConversationId,
    sealAfterMerge,
  );

  const activeConversation = selectActiveConversation(state);
  const composer = useComposerProps(
    store,
    client,
    state,
    isLoadingConversations,
    clearConversationError,
    reloadConversationList,
  );
  const handleRespondToPrompt = usePromptResponder(store, client);
  const activeEntries = useMemo(() => selectRecentEntries(state, DEFAULT_VISIBLE_WINDOW), [state]);
  const activeTranscriptSummary = useMemo(
    () => selectTranscriptSummary(state, DEFAULT_VISIBLE_WINDOW),
    [state],
  );
  const actionMap = useMemo(
    () => precomputeTranscriptActions(state, activeEntries),
    [state, activeEntries],
  );
  const turnActions = useTurnActions(
    store,
    client,
    reloadConversationList,
    sealAfterMerge,
    actionMap,
  );

  // ── Artifact hydration: populate artifact references on REST-loaded turns ──
  useArtifactHydration(store, client, state.activeConversationId, activeEntries);

  // ── Artifact inspection: select / show / close ─────────────────────────────
  const visibleArtifact = selectVisibleArtifact(state);

  // Monotonically-increasing request counter: every new selection, panel close,
  // or conversation switch bumps this so in-flight fetches become stale.
  const artifactRequestRef = useRef(0);

  // Invalidate in-flight artifact fetches when the active conversation changes.
  useEffect(() => {
    artifactRequestRef.current++;
  }, [state.activeConversationId]);

  const handleArtifactSelect = useCallback(
    (artifactId: string, turnId: string) => {
      const requestId = ++artifactRequestRef.current;

      // Show a loading placeholder immediately
      const entry = activeEntries.find((e) => e.turnId === turnId);
      const ref = entry?.artifacts.find((a) => a.artifactId === artifactId);
      const loadingArtifact: ArtifactViewState = {
        artifactId,
        turnId,
        kind: ref?.kind ?? 'file',
        label: ref?.label ?? artifactId,
        availability: 'loading',
        previewBlocks: [],
      };
      store.dispatch({ type: 'artifact/show', artifact: loadingArtifact });

      // Fetch full content in background with staleness guard
      void fetchArtifactContent(
        artifactId,
        requestId,
        () => artifactRequestRef.current,
        () => store.getState().activeConversationId === state.activeConversationId,
        client,
        (action) => {
          store.dispatch(action);
        },
        loadingArtifact,
      );
    },
    [activeEntries, client, state.activeConversationId, store],
  );

  const handleCloseArtifact = useCallback(() => {
    artifactRequestRef.current++;
    store.dispatch({ type: 'artifact/clear' });
  }, [store]);

  return (
    <ConnectionStateContext.Provider value={state.connection}>
      <ConnectionBanner
        connection={state.connection}
        staleControlReason={activeConversation?.controlState.staleReason ?? null}
      />
      <WorkspaceLayout
        conversations={selectConversationList(state)}
        activeConversationId={state.activeConversationId}
        activeConversation={activeConversation}
        activeEntries={activeEntries}
        activeHiddenEntryCount={activeTranscriptSummary.hiddenCount}
        activeLoadState={selectActiveLoadState(state)}
        activeHasMoreHistory={activeConversation?.hasMoreHistory ?? false}
        isLoadingConversations={isLoadingConversations}
        conversationErrorMessage={conversationErrorMessage}
        onSelectConversation={(conversationId) => {
          artifactRequestRef.current++;
          store.dispatch({ type: 'conversation/select', conversationId });
          clearConversationError();
          composer.clearCreateState();
        }}
        onStartNewConversation={() => {
          artifactRequestRef.current++;
          store.dispatch({ type: 'conversation/select', conversationId: null });
          clearConversationError();
          composer.clearCreateState();
        }}
        onRetryActiveTranscript={retryActiveTranscript}
        onRespondToPrompt={handleRespondToPrompt}
        onCancelTurn={turnActions.handleCancel}
        onRetryTurn={turnActions.handleRetry}
        onBranchTurn={turnActions.handleBranch}
        onFollowUpTurn={turnActions.handleFollowUp}
        onArtifactSelect={handleArtifactSelect}
        resolveEntryActions={turnActions.resolveEntryActions}
        visibleArtifact={visibleArtifact}
        onCloseArtifact={handleCloseArtifact}
        composerSlot={
          <ComposerPanel
            draftText={composer.draftText}
            submitState={composer.submitState}
            validationMessage={composer.validationMessage}
            canSubmit={composer.canSubmit}
            policyLabel={composer.policyLabel}
            disabled={composer.disabled}
            onDraftChange={composer.onDraftChange}
            onSubmit={composer.onSubmit}
          />
        }
        operationsPanelSlot={
          <OperationsPanelShell
            snapshotStatus={selectOpsSnapshotStatus(opsState)}
            freshness={selectOpsFreshness(opsState)}
            availability={selectOpsAvailability(opsState)}
          >
            <QueuePanel
              items={selectFilteredQueueItems(opsState)}
              snapshotStatus={selectOpsSnapshotStatus(opsState)}
              availability={selectOpsAvailability(opsState)}
              selectedWorkItemId={selectSelectedWorkItemId(opsState)}
              onSelectItem={(workItemId) =>
                dispatchOps({ type: 'selection/select', workItemId })
              }
              hasPendingControl={(workItemId) =>
                selectHasPendingControl(opsState, workItemId)
              }
            />
          </OperationsPanelShell>
        }
      />
    </ConnectionStateContext.Provider>
  );
}
