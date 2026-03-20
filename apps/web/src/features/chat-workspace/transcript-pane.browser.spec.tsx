import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';

import { TranscriptPane } from './components/transcript-pane.tsx';
import { TranscriptTurn } from './components/transcript-turn.tsx';
import type { TranscriptEntryState, ContentBlockState } from './model/workspace-store.ts';

afterEach(() => {
  cleanup();
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function textBlock(text: string, blockId = 'blk-1'): ContentBlockState {
  return { blockId, kind: 'text', text, metadata: null };
}

function codeBlock(text: string, blockId = 'blk-code-1'): ContentBlockState {
  return { blockId, kind: 'code', text, metadata: null };
}

function createEntry(overrides: Partial<TranscriptEntryState> = {}): TranscriptEntryState {
  return {
    entryId: 'entry-1',
    kind: 'turn',
    turnId: 'turn-1',
    status: 'completed',
    timestamp: '2026-03-20T12:00:00.000Z',
    contentBlocks: [],
    artifacts: [],
    controls: [],
    prompt: null,
    ...overrides,
  };
}

// ─── TranscriptTurn ─────────────────────────────────────────────────────────

describe('TranscriptTurn', () => {
  it('renders a turn entry with text content blocks', () => {
    const entry = createEntry({
      contentBlocks: [textBlock('Hello, operator.')],
    });

    render(<TranscriptTurn entry={entry} />);

    expect(screen.getByText('Hello, operator.')).toBeTruthy();
  });

  it('renders multiple content blocks in order', () => {
    const entry = createEntry({
      contentBlocks: [
        textBlock('First block', 'blk-1'),
        textBlock('Second block', 'blk-2'),
      ],
    });

    render(<TranscriptTurn entry={entry} />);

    expect(screen.getByText('First block')).toBeTruthy();
    expect(screen.getByText('Second block')).toBeTruthy();
  });

  it('renders code blocks with preformatted styling', () => {
    const entry = createEntry({
      contentBlocks: [codeBlock('const x = 42;')],
    });

    render(<TranscriptTurn entry={entry} />);

    const codeEl = screen.getByText('const x = 42;');
    expect(codeEl.closest('pre')).toBeTruthy();
  });

  it('displays the entry kind as a label', () => {
    const entry = createEntry({ kind: 'system-status' });

    render(<TranscriptTurn entry={entry} />);

    expect(screen.getByText('system-status')).toBeTruthy();
  });

  it('displays the formatted timestamp when present', () => {
    const entry = createEntry({ timestamp: '2026-03-20T12:00:00.000Z' });

    render(<TranscriptTurn entry={entry} />);

    const article = screen.getByRole('article');
    expect(article).toBeTruthy();
    // Timestamp rendered as time element
    const timeEl = article.querySelector('time');
    expect(timeEl).toBeTruthy();
    expect(timeEl?.getAttribute('dateTime')).toBe('2026-03-20T12:00:00.000Z');
  });

  it('omits the timestamp when null', () => {
    const entry = createEntry({ timestamp: null });

    render(<TranscriptTurn entry={entry} />);

    const article = screen.getByRole('article');
    expect(article.querySelector('time')).toBeNull();
  });

  it('renders an empty turn gracefully when contentBlocks is empty', () => {
    const entry = createEntry({ contentBlocks: [] });

    render(<TranscriptTurn entry={entry} />);

    // Should still render the article wrapper with no crash
    expect(screen.getByRole('article')).toBeTruthy();
  });

  it('shows the entry status', () => {
    const entry = createEntry({ status: 'in-progress' });

    render(<TranscriptTurn entry={entry} />);

    expect(screen.getByText('in-progress')).toBeTruthy();
  });
});

// ─── TranscriptPane ─────────────────────────────────────────────────────────

describe('TranscriptPane', () => {
  it('shows an empty state when no conversation is active', () => {
    render(
      <TranscriptPane
        entries={[]}
        loadState={null}
        hasActiveConversation={false}
      />,
    );

    expect(screen.getByText('Select a conversation to view its transcript.')).toBeTruthy();
  });

  it('shows a loading indicator when loadState is loading', () => {
    render(
      <TranscriptPane
        entries={[]}
        loadState="loading"
        hasActiveConversation={true}
      />,
    );

    expect(screen.getByText('Loading transcript…')).toBeTruthy();
  });

  it('shows an empty-entries message when conversation has no entries', () => {
    render(
      <TranscriptPane
        entries={[]}
        loadState="ready"
        hasActiveConversation={true}
      />,
    );

    expect(screen.getByText('No messages yet.')).toBeTruthy();
  });

  it('renders transcript entries when present', () => {
    const entries: TranscriptEntryState[] = [
      createEntry({
        entryId: 'e-1',
        contentBlocks: [textBlock('First turn')],
      }),
      createEntry({
        entryId: 'e-2',
        contentBlocks: [textBlock('Second turn')],
      }),
    ];

    render(
      <TranscriptPane
        entries={entries}
        loadState="ready"
        hasActiveConversation={true}
      />,
    );

    expect(screen.getByText('First turn')).toBeTruthy();
    expect(screen.getByText('Second turn')).toBeTruthy();
  });

  it('renders entries in stable DOM order matching the array order', () => {
    const entries: TranscriptEntryState[] = [
      createEntry({
        entryId: 'e-alpha',
        contentBlocks: [textBlock('Alpha')],
      }),
      createEntry({
        entryId: 'e-beta',
        contentBlocks: [textBlock('Beta')],
      }),
      createEntry({
        entryId: 'e-gamma',
        contentBlocks: [textBlock('Gamma')],
      }),
    ];

    render(
      <TranscriptPane
        entries={entries}
        loadState="ready"
        hasActiveConversation={true}
      />,
    );

    const articles = screen.getAllByRole('article');
    expect(articles).toHaveLength(3);
    expect(within(articles[0]).getByText('Alpha')).toBeTruthy();
    expect(within(articles[1]).getByText('Beta')).toBeTruthy();
    expect(within(articles[2]).getByText('Gamma')).toBeTruthy();
  });

  it('uses the transcript region role for the entries container', () => {
    render(
      <TranscriptPane
        entries={[]}
        loadState="ready"
        hasActiveConversation={true}
      />,
    );

    expect(screen.getByRole('log')).toBeTruthy();
  });

  it('shows idle state (no entries message) when loadState is idle with active conversation', () => {
    render(
      <TranscriptPane
        entries={[]}
        loadState="idle"
        hasActiveConversation={true}
      />,
    );

    expect(screen.getByText('No messages yet.')).toBeTruthy();
  });

  it('shows error state when loadState is error', () => {
    render(
      <TranscriptPane
        entries={[]}
        loadState="error"
        hasActiveConversation={true}
      />,
    );

    expect(screen.getByText('Failed to load transcript.')).toBeTruthy();
  });
});
