import type { JSX } from 'react';
import type {
  ArtifactReferenceState,
  ContentBlockState,
  TranscriptEntryState,
} from '../model/workspace-store.ts';
import { SafeText } from '../render/safe-text.tsx';
import { PromptCard } from './prompt-card.tsx';
import { TurnControlBar } from './turn-control-bar.tsx';

export interface TranscriptTurnCallbacks {
  readonly onRespondToPrompt?: (promptId: string, response: string) => void;
  readonly onCancelTurn?: (turnId: string) => void;
  readonly onRetryTurn?: (turnId: string) => void;
  readonly onBranchTurn?: (turnId: string) => void;
  readonly onFollowUpTurn?: (turnId: string) => void;
}

export interface TranscriptTurnProps extends TranscriptTurnCallbacks {
  readonly entry: TranscriptEntryState;
  readonly canCancel?: boolean;
  readonly canRetry?: boolean;
  readonly canBranch?: boolean;
  readonly canFollowUp?: boolean;
}

const turnStyle = {
  borderWidth: '1px',
  borderStyle: 'solid',
  borderColor: 'rgba(148, 163, 184, 0.15)',
  borderRadius: '0.5rem',
  background: 'rgba(30, 41, 59, 0.6)',
  padding: '0.75rem 1rem',
  display: 'grid',
  gap: '0.5rem',
} as const;

const streamingTurnStyle = {
  ...turnStyle,
  borderColor: 'rgba(56, 189, 248, 0.3)',
} as const;

const activityGroupStyle = {
  ...turnStyle,
  background: 'rgba(30, 41, 59, 0.35)',
  borderColor: 'rgba(148, 163, 184, 0.08)',
} as const;

const systemStatusStyle = {
  ...turnStyle,
  background: 'rgba(30, 41, 59, 0.25)',
  borderColor: 'rgba(251, 191, 36, 0.2)',
} as const;

const headerStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  fontSize: '0.8rem',
  color: '#94a3b8',
} as const;

const kindBadgeStyle = {
  background: 'rgba(148, 163, 184, 0.15)',
  borderRadius: '0.25rem',
  padding: '0.1rem 0.4rem',
  fontSize: '0.75rem',
  fontFamily: 'monospace',
} as const;

const streamingBadgeStyle = {
  ...kindBadgeStyle,
  background: 'rgba(56, 189, 248, 0.15)',
  color: '#38bdf8',
} as const;

const preStyle = {
  margin: 0,
  padding: '0.5rem 0.75rem',
  background: 'rgba(0, 0, 0, 0.3)',
  borderRadius: '0.375rem',
  fontSize: '0.875rem',
  overflowX: 'auto',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
} as const;

const statusBlockStyle = {
  margin: 0,
  lineHeight: 1.6,
  color: '#94a3b8',
  fontSize: '0.85rem',
  fontStyle: 'italic',
} as const;

const artifactListStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '0.4rem',
  margin: 0,
  padding: 0,
  listStyle: 'none',
} as const;

const artifactBadgeStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.3rem',
  background: 'rgba(148, 163, 184, 0.1)',
  border: '1px solid rgba(148, 163, 184, 0.15)',
  borderRadius: '0.25rem',
  padding: '0.15rem 0.5rem',
  fontSize: '0.75rem',
  color: '#94a3b8',
} as const;

const artifactKindStyle = {
  fontFamily: 'monospace',
  fontSize: '0.7rem',
  opacity: 0.7,
} as const;

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function ContentBlock({ block }: { readonly block: ContentBlockState }): JSX.Element | null {
  if (block.text == null) return null;

  if (block.kind === 'code') {
    return <pre style={preStyle}>{block.text}</pre>;
  }

  if (block.kind === 'status') {
    return (
      <p style={statusBlockStyle}>
        <SafeText text={block.text} />
      </p>
    );
  }

  if (block.kind === 'structured') {
    return <pre style={preStyle}>{block.text}</pre>;
  }

  // kind === 'text'
  return (
    <p style={{ margin: 0, lineHeight: 1.6 }}>
      <SafeText text={block.text} />
    </p>
  );
}

function ArtifactList({
  artifacts,
}: {
  readonly artifacts: readonly ArtifactReferenceState[];
}): JSX.Element | null {
  if (artifacts.length === 0) return null;

  return (
    <ul style={artifactListStyle} data-testid="artifact-list">
      {artifacts.map((artifact) => (
        <li key={artifact.artifactId} style={artifactBadgeStyle} data-testid="artifact-badge">
          <span style={artifactKindStyle}>{artifact.kind}</span>
          <SafeText text={artifact.label} />
        </li>
      ))}
    </ul>
  );
}

function isStreamingStatus(status: string): boolean {
  return status === 'streaming';
}

function resolveTurnStyle(
  entry: TranscriptEntryState,
  streaming: boolean,
): Record<string, string | number> {
  if (streaming) return streamingTurnStyle;
  if (entry.kind === 'activity-group') return activityGroupStyle;
  if (entry.kind === 'system-status') return systemStatusStyle;
  return turnStyle;
}

function noop(): void {
  /* no-op fallback for optional turn action callbacks */
}

export function TranscriptTurn({
  entry,
  onRespondToPrompt,
  canCancel = false,
  canRetry = false,
  canBranch = false,
  canFollowUp = false,
  onCancelTurn,
  onRetryTurn,
  onBranchTurn,
  onFollowUpTurn,
}: TranscriptTurnProps): JSX.Element {
  const streaming = isStreamingStatus(entry.status);
  const hasTurnId = entry.kind === 'turn' && entry.turnId != null;

  return (
    <article
      style={resolveTurnStyle(entry, streaming)}
      data-streaming={streaming ? 'true' : undefined}
      data-entry-kind={entry.kind}
    >
      <header style={headerStyle}>
        <span style={kindBadgeStyle}>{entry.kind}</span>
        {entry.attributionLabel != null && <span>{entry.attributionLabel}</span>}
        {streaming ? (
          <span style={streamingBadgeStyle}>streaming…</span>
        ) : (
          <span>{entry.status}</span>
        )}
        {entry.timestamp != null && (
          <time dateTime={entry.timestamp}>{formatTimestamp(entry.timestamp)}</time>
        )}
      </header>

      {entry.contentBlocks.length > 0 && (
        <div style={{ display: 'grid', gap: '0.4rem' }}>
          {entry.contentBlocks.map((block) => (
            <ContentBlock key={block.blockId} block={block} />
          ))}
        </div>
      )}

      <ArtifactList artifacts={entry.artifacts} />

      {entry.prompt != null && <PromptCard prompt={entry.prompt} onRespond={onRespondToPrompt} />}

      {hasTurnId && (
        <TurnControlBar
          entryId={entry.entryId}
          turnId={entry.turnId!}
          canCancel={canCancel}
          canRetry={canRetry}
          canBranch={canBranch}
          canFollowUp={canFollowUp}
          onCancel={onCancelTurn ?? noop}
          onRetry={onRetryTurn ?? noop}
          onBranch={onBranchTurn ?? noop}
          onFollowUp={onFollowUpTurn ?? noop}
        />
      )}
    </article>
  );
}
