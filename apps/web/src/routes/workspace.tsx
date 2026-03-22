import type { ApprovalRequest, Conversation, StreamEvent, Turn } from '@hydra/web-contracts';
import {
  type Dispatch,
  useCallback,
  useEffect,
  useMemo,
  type RefObject,
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
  type PromptViewState,
  submitComposerDraft,
  type DraftSubmitState,
  type StreamSubscriptionState,
  type TranscriptEntryState,
  type WorkspaceConversationRecord,
  type WorkspaceState,
  type WorkspaceStore,
} from '../features/chat-workspace/model/workspace-store.ts';
import {
  pickBestApprovalPerTurn,
  selectHydratedApprovalPrompt,
} from '../features/chat-workspace/model/approval-selection.ts';
import { claimApprovalHydrationRetry } from '../features/chat-workspace/model/approval-hydration-retries.ts';
import {
  selectActiveConversation,
  selectActiveDraft,
  selectActiveEntries,
  selectActiveLoadState,
  selectCanSubmit,
  selectConversationList,
  selectCreateModeCanSubmit,
} from '../features/chat-workspace/model/selectors.ts';
import {
  resolveResponseLabel,
  respondToPrompt,
} from '../features/chat-workspace/model/prompt-helpers.ts';

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
): () => void {
  if (activeConversationId == null) {
    return () => {};
  }

  const conversationId = activeConversationId;
  const existing = store.getState().conversations.get(conversationId);
  const shouldLoadHistory = existing?.historyLoaded !== true;

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

      if (pendingApprovals != null) {
        approvalRetryCountsRef.current.delete(conversationId);
      }
    } catch (err: unknown) {
      if (lifecycle.disposed) {
        return;
      }

      markTranscriptLoadError(store, conversationId, err);
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
// eslint-disable-next-line max-lines-per-function
function useStreamSubscription({
  store,
  streamClient,
  client,
  activeConversationId,
}: StreamSubscriptionDeps): void {
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
      ),
    [activeConversationId, client, retryNonce, store],
  );

  return useCallback(() => {
    setRetryNonce((value) => value + 1);
  }, []);
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

  const policyLabel = isLoadingConversations
    ? 'Loading conversations…'
    : (activeConversation?.controlState.submissionPolicyLabel ?? 'Ready for operator input');
  let canSubmit = createCanSubmit;
  if (!isCreateMode) {
    canSubmit = isLoadingConversations ? false : continueCanSubmit;
  }

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

export function WorkspaceRoute(): JSX.Element {
  const [store] = useState(() => createWorkspaceStore());
  const state = useWorkspaceState(store);
  const client = useMemo(() => createGatewayClient({ baseUrl: '' }), []);
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
  const retryActiveTranscript = useTranscriptLoader(store, client, state.activeConversationId);

  // Wire live stream subscription scoped to active conversation
  useStreamSubscription({
    store,
    streamClient: wsStreamClient,
    client,
    activeConversationId: state.activeConversationId,
  });

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

  return (
    <ConnectionStateContext.Provider value={state.connection}>
      <ConnectionBanner connection={state.connection} />
      <WorkspaceLayout
        conversations={selectConversationList(state)}
        activeConversationId={state.activeConversationId}
        activeConversation={activeConversation}
        activeEntries={selectActiveEntries(state)}
        activeLoadState={selectActiveLoadState(state)}
        activeHasMoreHistory={activeConversation?.hasMoreHistory ?? false}
        isLoadingConversations={isLoadingConversations}
        conversationErrorMessage={conversationErrorMessage}
        onSelectConversation={(conversationId) => {
          store.dispatch({ type: 'conversation/select', conversationId });
          clearConversationError();
          composer.clearCreateState();
        }}
        onStartNewConversation={() => {
          store.dispatch({ type: 'conversation/select', conversationId: null });
          clearConversationError();
          composer.clearCreateState();
        }}
        onRetryActiveTranscript={retryActiveTranscript}
        onRespondToPrompt={handleRespondToPrompt}
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
      />
    </ConnectionStateContext.Provider>
  );
}
