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

function useComposerProps(store: WorkspaceStore, client: GatewayClient, state: WorkspaceState) {
  const [createError, setCreateError] = useState<string | null>(null);

  const draft = selectActiveDraft(state);
  const activeConversation = selectActiveConversation(state);
  const canSubmit = selectCanSubmit(state);

  const handleDraftChange = useCallback(
    (text: string) => {
      const conversationId = store.getState().activeConversationId;
      if (conversationId != null) {
        store.dispatch({ type: 'draft/set-text', conversationId, draftText: text });
      }
    },
    [store],
  );

  const handleSubmit = useCallback(() => {
    if (state.activeConversationId == null) {
      const text = draft?.draftText ?? '';
      void createAndSubmitDraft({ store, client }, text).catch((err: unknown) => {
        setCreateError(err instanceof Error ? err.message : 'Failed to create conversation');
      });
      return;
    }
    void submitComposerDraft({ store, client });
  }, [store, client, state.activeConversationId, draft?.draftText]);

  const policyLabel =
    activeConversation?.controlState.submissionPolicyLabel ?? 'Ready for operator input';

  return {
    draftText: draft?.draftText ?? '',
    submitState: draft?.submitState ?? ('idle' as const),
    validationMessage: createError ?? draft?.validationMessage ?? null,
    canSubmit,
    policyLabel,
    activeConversation,
    onDraftChange: handleDraftChange,
    onSubmit: handleSubmit,
    clearCreateError: () => {
      setCreateError(null);
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

  const composer = useComposerProps(store, client, state);

  return (
    <WorkspaceLayout
      conversations={selectConversationList(state)}
      activeConversationId={state.activeConversationId}
      activeConversation={composer.activeConversation}
      isLoadingConversations={isLoadingConversations}
      conversationErrorMessage={conversationErrorMessage}
      onSelectConversation={(conversationId) => {
        store.dispatch({ type: 'conversation/select', conversationId });
        composer.clearCreateError();
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
