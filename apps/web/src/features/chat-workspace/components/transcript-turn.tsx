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

function formatTimestamp(iso: string): string {
  try {
    const date = new Date(iso);
    return date.toLocaleString();
  } catch {
    return iso;
  }
}

function ContentBlock({ block }: { readonly block: ContentBlockState }): JSX.Element | null {
  if (block.text == null) return null;

  if (block.kind === 'code') {
    return <pre style={preStyle}>{block.text}</pre>;
  }

  return <p style={{ margin: 0, lineHeight: 1.6 }}>{block.text}</p>;
}

export function TranscriptTurn({ entry }: TranscriptTurnProps): JSX.Element {
  return (
    <article style={turnStyle}>
      <header style={headerStyle}>
        <span style={kindBadgeStyle}>{entry.kind}</span>
        {entry.attributionLabel != null && <span>{entry.attributionLabel}</span>}
        <span>{entry.status}</span>
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
