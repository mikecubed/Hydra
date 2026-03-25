import type { JSX } from 'react';
import { ConversationList } from './conversation-list.tsx';
import { LineageBadge } from './lineage-badge.tsx';
import { TranscriptPane } from './transcript-pane.tsx';
import { ArtifactPanel } from './artifact-panel.tsx';
import type { EntryActionFlags } from '../model/selectors.ts';
import type { TranscriptTurnCallbacks } from './transcript-turn.tsx';
import type {
  ArtifactViewState,
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

export interface WorkspaceLayoutProps extends TranscriptTurnCallbacks {
  readonly conversations: readonly ConversationViewState[];
  readonly activeConversationId: string | null;
  readonly activeConversation: ConversationViewState | undefined;
  readonly activeEntries: readonly TranscriptEntryState[];
  readonly activeHiddenEntryCount?: number;
  readonly activeLoadState: ConversationLoadState | null;
  readonly activeHasMoreHistory: boolean;
  readonly isLoadingConversations: boolean;
  readonly conversationErrorMessage: string | null;
  readonly onSelectConversation: (conversationId: string) => void;
  readonly onStartNewConversation: () => void;
  readonly onRetryActiveTranscript: () => void;
  readonly resolveEntryActions?: (entry: TranscriptEntryState) => EntryActionFlags;
  readonly composerSlot?: JSX.Element | null;
  readonly visibleArtifact?: ArtifactViewState | null;
  readonly onCloseArtifact?: () => void;
  /** Optional operations panel rendered beside the chat workspace. */
  readonly operationsPanelSlot?: JSX.Element | null;
}

// eslint-disable-next-line max-lines-per-function
export function WorkspaceLayout({
  conversations,
  activeConversationId,
  activeConversation,
  activeEntries,
  activeHiddenEntryCount = 0,
  activeLoadState,
  activeHasMoreHistory,
  isLoadingConversations,
  conversationErrorMessage,
  onSelectConversation,
  onStartNewConversation,
  onRetryActiveTranscript,
  onRespondToPrompt,
  onCancelTurn,
  onRetryTurn,
  onBranchTurn,
  onFollowUpTurn,
  onArtifactSelect,
  resolveEntryActions,
  composerSlot,
  visibleArtifact,
  onCloseArtifact,
  operationsPanelSlot,
}: WorkspaceLayoutProps): JSX.Element {
  const chatSection = (
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
            onStartNewConversation={onStartNewConversation}
          />
        </section>

        <div style={{ display: 'grid', gap: '1rem' }}>
          <section aria-labelledby="workspace-transcript-heading" style={panelStyle}>
            <h3 id="workspace-transcript-heading" style={{ marginTop: 0 }}>
              Transcript
            </h3>
            <div
              style={{
                lineHeight: 1.6,
                marginBottom: '0.75rem',
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                flexWrap: 'wrap',
              }}
            >
              <span>
                Active conversation: {activeConversation?.title ?? 'No conversation selected'}
              </span>
              {activeConversation != null && (
                <LineageBadge lineage={activeConversation.lineageSummary} />
              )}
            </div>
            <TranscriptPane
              entries={activeEntries}
              loadState={activeLoadState}
              hasActiveConversation={activeConversationId != null}
              hasMoreHistory={activeHasMoreHistory}
              hiddenEntryCount={activeHiddenEntryCount}
              onRetry={onRetryActiveTranscript}
              onRespondToPrompt={onRespondToPrompt}
              onCancelTurn={onCancelTurn}
              onRetryTurn={onRetryTurn}
              onBranchTurn={onBranchTurn}
              onFollowUpTurn={onFollowUpTurn}
              onArtifactSelect={onArtifactSelect}
              resolveEntryActions={resolveEntryActions}
            />
          </section>

          {visibleArtifact != null && onCloseArtifact != null && (
            <ArtifactPanel artifact={visibleArtifact} onClose={onCloseArtifact} />
          )}

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

  if (operationsPanelSlot == null) {
    return chatSection;
  }

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr minmax(16rem, 20rem)',
        gap: '1.5rem',
        alignItems: 'start',
      }}
    >
      {chatSection}
      <aside aria-label="Operations sidebar">{operationsPanelSlot}</aside>
    </div>
  );
}
