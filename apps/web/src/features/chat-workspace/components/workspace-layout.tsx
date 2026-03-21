import type { JSX } from 'react';
import { ConversationList } from './conversation-list.tsx';
import { TranscriptPane } from './transcript-pane.tsx';
import type {
  ConversationLoadState,
  ConversationViewState,
  TranscriptEntryState,
} from '../model/workspace-store.ts';

const panelStyle = {
  border: '1px solid rgba(148, 163, 184, 0.2)',
  borderRadius: '0.75rem',
  background: 'rgba(15, 23, 42, 0.55)',
  padding: '1rem',
} as const;

export interface WorkspaceLayoutProps {
  readonly conversations: readonly ConversationViewState[];
  readonly activeConversationId: string | null;
  readonly activeConversation: ConversationViewState | undefined;
  readonly activeEntries: readonly TranscriptEntryState[];
  readonly activeLoadState: ConversationLoadState | null;
  readonly activeHasMoreHistory: boolean;
  readonly isLoadingConversations: boolean;
  readonly conversationErrorMessage: string | null;
  readonly onSelectConversation: (conversationId: string) => void;
  readonly onRetryActiveTranscript: () => void;
  readonly composerSlot?: JSX.Element | null;
}

export function WorkspaceLayout({
  conversations,
  activeConversationId,
  activeConversation,
  activeEntries,
  activeLoadState,
  activeHasMoreHistory,
  isLoadingConversations,
  conversationErrorMessage,
  onSelectConversation,
  onRetryActiveTranscript,
  composerSlot,
}: WorkspaceLayoutProps): JSX.Element {
  const activeTitle = activeConversation?.title ?? 'No conversation selected';

  return (
    <section
      aria-labelledby="conversation-workspace-heading"
      style={{ display: 'grid', gap: '1.5rem' }}
    >
      <header style={{ display: 'grid', gap: '0.75rem' }}>
        <h2 id="conversation-workspace-heading" style={{ margin: 0, fontSize: '1.5rem' }}>
          Conversation workspace
        </h2>
        <p style={{ lineHeight: 1.6, margin: 0, maxWidth: '52rem' }}>
          The Phase 1 shell wires the browser workspace around a dedicated route so the conversation
          list, transcript, and composer can land without reworking navigation again.
        </p>
      </header>

      <div
        style={{
          display: 'grid',
          gap: '1rem',
          gridTemplateColumns: 'minmax(15rem, 18rem) minmax(0, 1fr)',
          alignItems: 'start',
        }}
      >
        <section aria-labelledby="workspace-conversations-heading" style={panelStyle}>
          <h3 id="workspace-conversations-heading" style={{ marginTop: 0 }}>
            Conversations
          </h3>
          <ConversationList
            conversations={conversations}
            activeConversationId={activeConversationId}
            isLoading={isLoadingConversations}
            errorMessage={conversationErrorMessage}
            onSelectConversation={onSelectConversation}
          />
        </section>

        <div style={{ display: 'grid', gap: '1rem' }}>
          <section aria-labelledby="workspace-transcript-heading" style={panelStyle}>
            <h3 id="workspace-transcript-heading" style={{ marginTop: 0 }}>
              Transcript
            </h3>
            <p style={{ lineHeight: 1.6, marginBottom: '0.75rem' }}>
              Active conversation: {activeTitle}
            </p>
            <TranscriptPane
              entries={activeEntries}
              loadState={activeLoadState}
              hasActiveConversation={activeConversationId != null}
              hasMoreHistory={activeHasMoreHistory}
              onRetry={onRetryActiveTranscript}
            />
          </section>

          <section aria-labelledby="workspace-composer-heading" style={panelStyle}>
            <h3 id="workspace-composer-heading" style={{ marginTop: 0 }}>
              Composer
            </h3>
            {composerSlot ?? (
              <p style={{ lineHeight: 1.6, marginBottom: 0 }}>No active conversation selected.</p>
            )}
          </section>
        </div>
      </div>
    </section>
  );
}
