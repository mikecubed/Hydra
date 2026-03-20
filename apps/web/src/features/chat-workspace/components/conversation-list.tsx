import type { JSX } from 'react';
import type { ConversationViewState } from '../model/workspace-store.ts';

export interface ConversationListProps {
  readonly conversations: readonly ConversationViewState[];
  readonly activeConversationId: string | null;
  readonly isLoading: boolean;
  readonly errorMessage: string | null;
  readonly onSelectConversation: (conversationId: string) => void;
}

const listStyle = {
  display: 'grid',
  gap: '0.75rem',
  listStyle: 'none',
  margin: 0,
  padding: 0,
} as const;

const buttonStyle = {
  width: '100%',
  border: '1px solid rgba(148, 163, 184, 0.2)',
  borderRadius: '0.75rem',
  background: 'rgba(30, 41, 59, 0.85)',
  color: 'inherit',
  cursor: 'pointer',
  display: 'grid',
  gap: '0.4rem',
  padding: '0.9rem',
  textAlign: 'left',
} as const;

export function ConversationList({
  conversations,
  activeConversationId,
  isLoading,
  errorMessage,
  onSelectConversation,
}: ConversationListProps): JSX.Element {
  if (isLoading) {
    return <p style={{ lineHeight: 1.6, marginBottom: 0 }}>Loading conversations…</p>;
  }

  if (errorMessage != null) {
    return (
      <p role="alert" style={{ color: '#fca5a5', lineHeight: 1.6, marginBottom: 0 }}>
        {errorMessage}
      </p>
    );
  }

  if (conversations.length === 0) {
    return <p style={{ lineHeight: 1.6, marginBottom: 0 }}>No conversations are available yet.</p>;
  }

  return (
    <ul style={listStyle}>
      {conversations.map((conversation) => {
        const isActive = conversation.conversationId === activeConversationId;

        return (
          <li key={conversation.conversationId}>
            <button
              type="button"
              aria-pressed={isActive}
              onClick={() => {
                onSelectConversation(conversation.conversationId);
              }}
              style={{
                ...buttonStyle,
                border: isActive
                  ? '1px solid rgba(96, 165, 250, 0.75)'
                  : '1px solid rgba(148, 163, 184, 0.2)',
                background: isActive ? 'rgba(30, 64, 175, 0.35)' : buttonStyle.background,
              }}
            >
              <span style={{ fontSize: '1rem', fontWeight: 600 }}>{conversation.title}</span>
              <span style={{ color: '#94a3b8', fontSize: '0.875rem' }}>
                {conversation.turnCount} turns · {conversation.pendingInstructionCount} pending
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
