import type { Conversation, Turn } from '@hydra/web-contracts';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type JSX } from 'react';
import { WorkspaceLayout } from '../features/chat-workspace/components/workspace-layout.tsx';
import { ComposerPanel } from '../features/chat-workspace/components/composer-panel.tsx';
import { createGatewayClient } from '../features/chat-workspace/api/gateway-client.ts';
import type { GatewayClient } from '../features/chat-workspace/api/gateway-client.ts';
import {
  type ContentBlockState,
  createAndSubmitDraft,
  createWorkspaceStore,
  submitComposerDraft,
  type DraftSubmitState,
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
    } catch {
      // Best-effort background refresh; don't overwrite existing UI state.
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
    if (existing?.loadState === 'ready') {
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

        store.dispatch({
          type: 'conversation/replace-entries',
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
  refreshTranscript: () => void,
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
            refreshTranscript();
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
        refreshTranscript();
        void reloadConversationList();
      }
    });
  }, [
    clearConversationError,
    client,
    createDraftText,
    isLoadingConversations,
    refreshTranscript,
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

export function WorkspaceRoute(): JSX.Element {
  const [store] = useState(() => createWorkspaceStore());
  const state = useWorkspaceState(store);
  const client = useMemo(() => createGatewayClient({ baseUrl: '' }), []);
  const {
    isLoadingConversations,
    conversationErrorMessage,
    clearConversationError,
    reloadConversationList,
  } = useConversationListLoader(store, client);
  const retryActiveTranscript = useTranscriptLoader(store, client, state.activeConversationId);
  const activeConversation = selectActiveConversation(state);
  const composer = useComposerProps(
    store,
    client,
    state,
    isLoadingConversations,
    clearConversationError,
    retryActiveTranscript,
    reloadConversationList,
  );

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
      composerSlot={
        <ComposerPanel
          draftText={composer.draftText}
          submitState={composer.submitState}
          validationMessage={composer.validationMessage}
          canSubmit={composer.canSubmit}
          policyLabel={composer.policyLabel}
          onDraftChange={composer.onDraftChange}
          onSubmit={composer.onSubmit}
        />
      }
    />
  );
}
