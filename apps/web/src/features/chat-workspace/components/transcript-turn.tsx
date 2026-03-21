import type { JSX } from 'react';
import type { ContentBlockState, TranscriptEntryState } from '../model/workspace-store.ts';

export interface TranscriptTurnProps {
  readonly entry: TranscriptEntryState;
}

const turnStyle = {
  border: '1px solid rgba(148, 163, 184, 0.15)',
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
    return <p style={statusBlockStyle}>{block.text}</p>;
  }

  if (block.kind === 'structured') {
    return <pre style={preStyle}>{block.text}</pre>;
  }

  // kind === 'text'
  return <p style={{ margin: 0, lineHeight: 1.6 }}>{block.text}</p>;
}

function isStreamingStatus(status: string): boolean {
  return status === 'streaming';
}

export function TranscriptTurn({ entry }: TranscriptTurnProps): JSX.Element {
  const streaming = isStreamingStatus(entry.status);

  return (
    <article
      style={streaming ? streamingTurnStyle : turnStyle}
      data-streaming={streaming ? 'true' : undefined}
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
    </article>
  );
}
