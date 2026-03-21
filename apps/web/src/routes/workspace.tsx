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

function useComposerProps(
  store: WorkspaceStore,
  client: GatewayClient,
  state: WorkspaceState,
  isLoadingConversations: boolean,
  clearConversationError: () => void,
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
        .then(() => {
          setCreateDraftText('');
          clearConversationError();
        })
        .catch((err: unknown) => {
          setCreateError(err instanceof Error ? err.message : 'Failed to create conversation');
        })
        .finally(() => {
          setCreateSubmitting(false);
        });
      return;
    }
    void submitComposerDraft({ store, client });
  }, [clearConversationError, client, createDraftText, isLoadingConversations, store]);

  const policyLabel = isLoadingConversations
    ? 'Loading conversations…'
    : (activeConversation?.controlState.submissionPolicyLabel ?? 'Ready for operator input');

  const effectiveSubmitState = isCreateMode
    ? createSubmitting
      ? ('submitting' as const)
      : createError != null
        ? ('error' as const)
        : ('idle' as const)
    : (draft?.submitState ?? ('idle' as const));

  return {
    draftText: isCreateMode ? createDraftText : (draft?.draftText ?? ''),
    submitState: effectiveSubmitState,
    validationMessage: isCreateMode ? createError : (draft?.validationMessage ?? null),
    canSubmit: isCreateMode ? createCanSubmit : !isLoadingConversations && continueCanSubmit,
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
  const [isLoadingConversations, setIsLoadingConversations] = useState(true);
  const [conversationErrorMessage, setConversationErrorMessage] = useState<string | null>(null);
  const [transcriptRetryNonce, setTranscriptRetryNonce] = useState(0);

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

  useEffect(() => {
    if (state.activeConversationId == null) {
      return;
    }

    const conversationId = state.activeConversationId;
    const existing = store.getState().conversations.get(conversationId);
    if (existing != null && existing.loadState === 'ready') {
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
      } catch {
        if (disposed) {
          return;
        }

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
  }, [client, state.activeConversationId, store, transcriptRetryNonce]);

  const activeConversation = selectActiveConversation(state);
  const composer = useComposerProps(store, client, state, isLoadingConversations, () => {
    setConversationErrorMessage(null);
  });

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
        setConversationErrorMessage(null);
        composer.clearCreateState();
      }}
      onRetryActiveTranscript={() => {
        setTranscriptRetryNonce((value) => value + 1);
      }}
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
