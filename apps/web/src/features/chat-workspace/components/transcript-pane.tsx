import type { JSX } from 'react';
import type { ConversationLoadState, TranscriptEntryState } from '../model/workspace-store.ts';
import type { EntryActionFlags } from '../model/selectors.ts';
import { NO_ACTION_FLAGS } from '../model/selectors.ts';
import type { TranscriptTurnCallbacks } from './transcript-turn.tsx';
import { TranscriptTurn } from './transcript-turn.tsx';

export interface TranscriptPaneProps extends TranscriptTurnCallbacks {
  readonly entries: readonly TranscriptEntryState[];
  readonly loadState: ConversationLoadState | null;
  readonly hasActiveConversation: boolean;
  readonly hasMoreHistory?: boolean;
  readonly onRetry?: () => void;
  /**
   * Resolve per-entry turn action flags. The parent computes eligibility
   * from store selectors so the pane stays pure.
   */
  readonly resolveEntryActions?: (entry: TranscriptEntryState) => EntryActionFlags;
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

// eslint-disable-next-line max-lines-per-function
export function TranscriptPane({
  entries,
  loadState,
  hasActiveConversation,
  hasMoreHistory = false,
  onRetry,
  onRespondToPrompt,
  onCancelTurn,
  onRetryTurn,
  onBranchTurn,
  onFollowUpTurn,
  onArtifactSelect,
  resolveEntryActions,
}: TranscriptPaneProps): JSX.Element {
  if (!hasActiveConversation) {
    return (
      <div role="log" style={paneStyle}>
        <p style={emptyStyle}>Select a conversation to view its transcript.</p>
      </div>
    );
  }

  if (loadState === 'loading' && entries.length === 0) {
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
        {onRetry != null && (
          <button
            type="button"
            onClick={onRetry}
            style={{
              justifySelf: 'start',
              border: '1px solid rgba(148, 163, 184, 0.3)',
              borderRadius: '0.375rem',
              background: 'rgba(30, 41, 59, 0.85)',
              color: 'inherit',
              cursor: 'pointer',
              padding: '0.5rem 0.75rem',
            }}
          >
            Retry transcript load
          </button>
        )}
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
      {loadState === 'loading' && <p style={emptyStyle}>Loading transcript…</p>}
      {hasMoreHistory && (
        <p style={emptyStyle}>
          Showing the most recent transcript entries. Older history is not loaded yet.
        </p>
      )}
      {entries.map((entry) => {
        const flags = resolveEntryActions?.(entry) ?? NO_ACTION_FLAGS;
        return (
          <TranscriptTurn
            key={entry.entryId}
            entry={entry}
            onRespondToPrompt={onRespondToPrompt}
            canCancel={flags.canCancel}
            canRetry={flags.canRetry}
            canBranch={flags.canBranch}
            canFollowUp={flags.canFollowUp}
            onCancelTurn={onCancelTurn}
            onRetryTurn={onRetryTurn}
            onBranchTurn={onBranchTurn}
            onFollowUpTurn={onFollowUpTurn}
            onArtifactSelect={onArtifactSelect}
          />
        );
      })}
    </div>
  );
}
