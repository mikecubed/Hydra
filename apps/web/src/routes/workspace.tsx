import type { Conversation } from '@hydra/web-contracts';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type JSX } from 'react';
import { WorkspaceLayout } from '../features/chat-workspace/components/workspace-layout.tsx';
import { ComposerPanel } from '../features/chat-workspace/components/composer-panel.tsx';
import { createGatewayClient } from '../features/chat-workspace/api/gateway-client.ts';
import type { GatewayClient } from '../features/chat-workspace/api/gateway-client.ts';
import {
  createWorkspaceStore,
  submitComposerDraft,
  createAndSubmitDraft,
  type WorkspaceConversationRecord,
  type WorkspaceState,
  type WorkspaceStore,
} from '../features/chat-workspace/model/workspace-store.ts';
import {
  selectActiveConversation,
  selectActiveDraft,
  selectCanSubmit,
  selectCreateModeCanSubmit,
  selectConversationList,
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

function useComposerProps(
  store: WorkspaceStore,
  client: GatewayClient,
  state: WorkspaceState,
  isLoadingConversations: boolean,
) {
  // Local state for create mode (no active conversation).
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
  }, [client, createDraftText, isLoadingConversations, store]);

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

  useEffect(() => {
    let disposed = false;

    async function loadConversations(): Promise<void> {
      setIsLoadingConversations(true);
      setConversationErrorMessage(null);

      try {
        const response = await client.listConversations({ status: 'active', limit: 20 });
        if (disposed) return;

        store.dispatch({
          type: 'conversation/replace-all',
          conversations: response.conversations.map(toWorkspaceConversationRecord),
        });
      } catch (err) {
        if (disposed) return;

        setConversationErrorMessage(
          err instanceof Error ? err.message : 'Unable to load conversations.',
        );
      } finally {
        if (!disposed) setIsLoadingConversations(false);
      }
    }

    void loadConversations();
    return () => {
      disposed = true;
    };
  }, [client, store]);

  const composer = useComposerProps(store, client, state, isLoadingConversations);

  return (
    <WorkspaceLayout
      conversations={selectConversationList(state)}
      activeConversationId={state.activeConversationId}
      activeConversation={composer.activeConversation}
      isLoadingConversations={isLoadingConversations}
      conversationErrorMessage={conversationErrorMessage}
      onSelectConversation={(conversationId) => {
        store.dispatch({ type: 'conversation/select', conversationId });
        composer.clearCreateState();
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
