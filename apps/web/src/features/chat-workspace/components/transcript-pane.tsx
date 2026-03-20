import type { JSX } from 'react';
import type { ConversationLoadState, TranscriptEntryState } from '../model/workspace-store.ts';
import { TranscriptTurn } from './transcript-turn.tsx';

export interface TranscriptPaneProps {
  readonly entries: readonly TranscriptEntryState[];
  readonly loadState: ConversationLoadState | null;
  readonly hasActiveConversation: boolean;
}

const paneStyle = {
  display: 'grid',
  gap: '0.75rem',
} as const;

const emptyStyle = {
  lineHeight: 1.6,
  marginBottom: 0,
  color: '#94a3b8',
} as const;

export function TranscriptPane({
  entries,
  loadState,
  hasActiveConversation,
}: TranscriptPaneProps): JSX.Element {
  if (!hasActiveConversation) {
    return (
      <div role="log" style={paneStyle}>
        <p style={emptyStyle}>Select a conversation to view its transcript.</p>
      </div>
    );
  }

  if (loadState === 'loading') {
    return (
      <div role="log" style={paneStyle}>
        <p style={emptyStyle}>Loading transcript…</p>
      </div>
    );
  }

  if (loadState === 'error') {
    return (
      <div role="log" style={paneStyle}>
        <p role="alert" style={{ ...emptyStyle, color: '#fca5a5' }}>
          Failed to load transcript.
        </p>
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div role="log" style={paneStyle}>
        <p style={emptyStyle}>No messages yet.</p>
      </div>
    );
  }

  return (
    <div role="log" style={paneStyle}>
      {entries.map((entry) => (
        <TranscriptTurn key={entry.entryId} entry={entry} />
      ))}
    </div>
  );
}
