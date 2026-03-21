import type { Conversation, Turn } from '@hydra/web-contracts';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type JSX,
} from 'react';
import { WorkspaceLayout } from '../features/chat-workspace/components/workspace-layout.tsx';
import { ComposerPanel } from '../features/chat-workspace/components/composer-panel.tsx';
import { createGatewayClient } from '../features/chat-workspace/api/gateway-client.ts';
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
  submitComposerDraft,
  type DraftSubmitState,
  type StreamSubscriptionState,
  type TranscriptEntryState,
  type WorkspaceConversationRecord,
  type WorkspaceState,
  type WorkspaceStore,
} from '../features/chat-workspace/model/workspace-store.ts';
import {
  selectActiveConversation,
  selectActiveDraft,
  selectActiveEntries,
  selectActiveLoadState,
  selectCanSubmit,
  selectConversationList,
  selectCreateModeCanSubmit,
} from '../features/chat-workspace/model/selectors.ts';
import { respondToPrompt } from '../features/chat-workspace/model/prompt-helpers.ts';

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

// ─── Stream subscription hook ───────────────────────────────────────────────

const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const RECONNECT_MAX_ATTEMPTS = 10;

export interface StreamSubscriptionDeps {
  readonly store: WorkspaceStore;
  readonly streamClient: StreamClient;
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

  // Connect / disconnect lifecycle
  // eslint-disable-next-line max-lines-per-function
  useEffect(() => {
    intentionalCloseRef.current = false;

    function clearReconnectTimer(): void {
      if (reconnectTimerRef.current != null) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    }

    function scheduleReconnect(): void {
      clearReconnectTimer();

      if (reconnectAttemptRef.current >= RECONNECT_MAX_ATTEMPTS) {
        store.dispatch({
          type: 'connection/merge',
          patch: { transportStatus: 'disconnected' },
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
        patch: { transportStatus: 'reconnecting' },
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
      },
    );

    callbacksRef.current = callbacks;
    streamClient.connect(callbacks);

    return () => {
      intentionalCloseRef.current = true;
      clearReconnectTimer();
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

  useEffect(() => {
    if (activeConversationId == null) {
      return;
    }

    const conversationId = activeConversationId;
    const existing = store.getState().conversations.get(conversationId);
    if (existing?.historyLoaded === true) {
      return;
    }

    let disposed = false;

    async function loadTranscript(): Promise<void> {
      store.dispatch({
        type: 'conversation/set-load-state',
        conversationId,
        loadState: 'loading',
      });

      try {
        const response = await client.loadHistory(conversationId, { limit: 50 });
        if (disposed) {
          return;
        }

        // If streaming already populated the transcript (setting loadState
        // to 'ready') while the REST call was in flight, merge history with
        // stream-owned entries instead of skipping entirely. This preserves
        // authoritative older history AND any live stream entries.
        store.dispatch({
          type: 'conversation/merge-history',
          conversationId,
          entries: response.turns.map(toTranscriptEntry),
          hasMoreHistory: response.hasMore,
        });
      } catch (err: unknown) {
        if (disposed) {
          return;
        }

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
    }

    void loadTranscript();
    return () => {
      disposed = true;
    };
  }, [activeConversationId, client, retryNonce, store]);

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
  );
}
