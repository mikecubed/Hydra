import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ListConversationsResponse, LoadTurnHistoryResponse } from '@hydra/web-contracts';

import { AppProviders } from '../../app/providers.tsx';
import { TranscriptPane } from './components/transcript-pane.tsx';
import { TranscriptTurn } from './components/transcript-turn.tsx';
import type { TranscriptEntryState, ContentBlockState } from './model/workspace-store.ts';

const fetchSpy = vi.fn<typeof fetch>();

afterEach(() => {
  fetchSpy.mockReset();
  vi.unstubAllGlobals();
  cleanup();
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function textBlock(text: string, blockId = 'blk-1'): ContentBlockState {
  return { blockId, kind: 'text', text, metadata: null };
}

function codeBlock(text: string, blockId = 'blk-code-1'): ContentBlockState {
  return { blockId, kind: 'code', text, metadata: null };
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }

  if (input instanceof URL) {
    return input.toString();
  }

  return input.url;
}

function installFetchStub(handler: (url: string, init: RequestInit | undefined) => Response): void {
  fetchSpy.mockImplementation((input, init) => Promise.resolve(handler(requestUrl(input), init)));
  vi.stubGlobal('fetch', fetchSpy);
}

function createEntry(overrides: Partial<TranscriptEntryState> = {}): TranscriptEntryState {
  return {
    entryId: 'entry-1',
    kind: 'turn',
    turnId: 'turn-1',
    attributionLabel: null,
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
      contentBlocks: [textBlock('First block', 'blk-1'), textBlock('Second block', 'blk-2')],
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

  it('shows the attribution label when present', () => {
    const entry = createEntry({ attributionLabel: 'Codex' });

    render(<TranscriptTurn entry={entry} />);

    expect(screen.getByText('Codex')).toBeTruthy();
  });

  it('falls back to the raw ISO string for an invalid timestamp', () => {
    const entry = createEntry({ timestamp: 'not-a-date' });

    render(<TranscriptTurn entry={entry} />);

    const timeEl = screen.getByRole('article').querySelector('time');
    expect(timeEl).toBeTruthy();
    expect(timeEl?.textContent).toBe('not-a-date');
  });
});

// ─── TranscriptPane ─────────────────────────────────────────────────────────

// eslint-disable-next-line max-lines-per-function
describe('TranscriptPane', () => {
  it('loads transcript history for the auto-selected active conversation', async () => {
    const conversations: ListConversationsResponse = {
      conversations: [
        {
          id: 'conv-1',
          title: 'Primary conversation',
          status: 'active',
          createdAt: '2026-03-20T00:00:00.000Z',
          updatedAt: '2026-03-20T12:00:00.000Z',
          turnCount: 2,
          pendingInstructionCount: 0,
        },
      ],
      totalCount: 1,
    };
    const history: LoadTurnHistoryResponse = {
      turns: [
        {
          id: 'turn-1',
          conversationId: 'conv-1',
          position: 1,
          kind: 'operator',
          attribution: { type: 'operator', label: 'Operator' },
          instruction: 'Summarize the latest changes.',
          status: 'completed',
          createdAt: '2026-03-20T12:00:00.000Z',
          completedAt: '2026-03-20T12:00:30.000Z',
        },
        {
          id: 'turn-2',
          conversationId: 'conv-1',
          position: 2,
          kind: 'system',
          attribution: { type: 'agent', agentId: 'codex', label: 'Codex' },
          response: 'The latest changes add conversation browsing.',
          status: 'completed',
          createdAt: '2026-03-20T12:00:31.000Z',
          completedAt: '2026-03-20T12:00:45.000Z',
        },
      ],
      totalCount: 2,
      hasMore: false,
    };

    installFetchStub((url) => {
      if (url === '/conversations?status=active&limit=20') {
        return new Response(JSON.stringify(conversations), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url === '/conversations/conv-1/turns?limit=50') {
        return new Response(JSON.stringify(history), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      throw new Error(`Unexpected fetch input: ${url}`);
    });

    render(<AppProviders />);

    expect(await screen.findByText('Summarize the latest changes.')).toBeTruthy();
    expect(screen.getByText('The latest changes add conversation browsing.')).toBeTruthy();
    expect(screen.getByText('Operator')).toBeTruthy();
    expect(screen.getByText('Codex')).toBeTruthy();
  });

  it('renders persisted pending approvals loaded alongside transcript history', async () => {
    const conversations: ListConversationsResponse = {
      conversations: [
        {
          id: 'conv-1',
          title: 'Primary conversation',
          status: 'active',
          createdAt: '2026-03-20T00:00:00.000Z',
          updatedAt: '2026-03-20T12:00:00.000Z',
          turnCount: 1,
          pendingInstructionCount: 0,
        },
      ],
      totalCount: 1,
    };
    const history: LoadTurnHistoryResponse = {
      turns: [
        {
          id: 'turn-1',
          conversationId: 'conv-1',
          position: 1,
          kind: 'system',
          attribution: { type: 'agent', agentId: 'codex', label: 'Codex' },
          response: 'Waiting for approval before continuing.',
          status: 'executing',
          createdAt: '2026-03-20T12:00:31.000Z',
          completedAt: '2026-03-20T12:00:45.000Z',
        },
      ],
      totalCount: 1,
      hasMore: false,
    };

    installFetchStub((url) => {
      if (url === '/conversations?status=active&limit=20') {
        return new Response(JSON.stringify(conversations), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url === '/conversations/conv-1/turns?limit=50') {
        return new Response(JSON.stringify(history), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url === '/conversations/conv-1/approvals') {
        return new Response(
          JSON.stringify({
            approvals: [
              {
                id: 'approval-1',
                turnId: 'turn-1',
                status: 'pending',
                prompt: 'Approve the proposed file changes?',
                context: { files: ['src/index.ts'] },
                contextHash: 'ctx-1',
                responseOptions: [
                  { key: 'approve', label: 'Approve' },
                  { key: 'deny', label: 'Deny' },
                ],
                createdAt: '2026-03-20T12:00:40.000Z',
              },
            ],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }

      throw new Error(`Unexpected fetch input: ${url}`);
    });

    render(<AppProviders />);

    expect(await screen.findByText('Approve the proposed file changes?')).toBeTruthy();
    expect(screen.getByTestId('approval-prompt')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'approve' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'deny' })).toBeTruthy();
  });

  it('surfaces when older transcript history has not been loaded yet', async () => {
    const conversations: ListConversationsResponse = {
      conversations: [
        {
          id: 'conv-1',
          title: 'Primary conversation',
          status: 'active',
          createdAt: '2026-03-20T00:00:00.000Z',
          updatedAt: '2026-03-20T12:00:00.000Z',
          turnCount: 75,
          pendingInstructionCount: 0,
        },
      ],
      totalCount: 1,
    };
    const history: LoadTurnHistoryResponse = {
      turns: [
        {
          id: 'turn-1',
          conversationId: 'conv-1',
          position: 51,
          kind: 'operator',
          attribution: { type: 'operator', label: 'Operator' },
          instruction: 'Newest visible turn',
          status: 'completed',
          createdAt: '2026-03-20T12:00:00.000Z',
          completedAt: '2026-03-20T12:00:30.000Z',
        },
      ],
      totalCount: 75,
      hasMore: true,
    };

    installFetchStub((url) => {
      if (url === '/conversations?status=active&limit=20') {
        return new Response(JSON.stringify(conversations), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url === '/conversations/conv-1/turns?limit=50') {
        return new Response(JSON.stringify(history), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      throw new Error(`Unexpected fetch input: ${url}`);
    });

    render(<AppProviders />);

    expect(await screen.findByText('Newest visible turn')).toBeTruthy();
    expect(
      screen.getByText(
        'Showing the most recent transcript entries. Older history is not loaded yet.',
      ),
    ).toBeTruthy();
  });

  // eslint-disable-next-line max-lines-per-function
  it('replaces transcript history when switching conversations', async () => {
    const conversations: ListConversationsResponse = {
      conversations: [
        {
          id: 'conv-1',
          title: 'Primary conversation',
          status: 'active',
          createdAt: '2026-03-20T00:00:00.000Z',
          updatedAt: '2026-03-20T12:00:00.000Z',
          turnCount: 1,
          pendingInstructionCount: 0,
        },
        {
          id: 'conv-2',
          title: 'Release follow-up',
          status: 'active',
          createdAt: '2026-03-20T00:05:00.000Z',
          updatedAt: '2026-03-20T12:05:00.000Z',
          turnCount: 1,
          pendingInstructionCount: 0,
        },
      ],
      totalCount: 2,
    };
    const firstHistory: LoadTurnHistoryResponse = {
      turns: [
        {
          id: 'turn-1',
          conversationId: 'conv-1',
          position: 1,
          kind: 'operator',
          attribution: { type: 'operator', label: 'Operator' },
          instruction: 'First transcript entry',
          status: 'completed',
          createdAt: '2026-03-20T12:00:00.000Z',
          completedAt: '2026-03-20T12:00:10.000Z',
        },
      ],
      totalCount: 1,
      hasMore: false,
    };
    const secondHistory: LoadTurnHistoryResponse = {
      turns: [
        {
          id: 'turn-2',
          conversationId: 'conv-2',
          position: 1,
          kind: 'system',
          attribution: { type: 'agent', agentId: 'codex', label: 'Codex' },
          response: 'Second transcript entry',
          status: 'completed',
          createdAt: '2026-03-20T12:01:00.000Z',
          completedAt: '2026-03-20T12:01:10.000Z',
        },
      ],
      totalCount: 1,
      hasMore: false,
    };

    installFetchStub((url) => {
      if (url === '/conversations?status=active&limit=20') {
        return new Response(JSON.stringify(conversations), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url === '/conversations/conv-1/turns?limit=50') {
        return new Response(JSON.stringify(firstHistory), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url === '/conversations/conv-2/turns?limit=50') {
        return new Response(JSON.stringify(secondHistory), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      throw new Error(`Unexpected fetch input: ${url}`);
    });

    render(<AppProviders />);

    expect(await screen.findByText('First transcript entry')).toBeTruthy();

    screen.getByRole('button', { name: /release follow-up/i }).click();

    expect(await screen.findByText('Second transcript entry')).toBeTruthy();
    expect(screen.queryByText('First transcript entry')).toBeNull();
    expect(fetchSpy).toHaveBeenCalledWith(
      '/conversations/conv-2/turns?limit=50',
      expect.objectContaining({ credentials: 'include', method: 'GET' }),
    );
  });

  it('shows an empty state when no conversation is active', () => {
    render(<TranscriptPane entries={[]} loadState={null} hasActiveConversation={false} />);

    expect(screen.getByText('Select a conversation to view its transcript.')).toBeTruthy();
  });

  it('retries transcript loading for the active conversation from the error state', async () => {
    const conversations: ListConversationsResponse = {
      conversations: [
        {
          id: 'conv-1',
          title: 'Primary conversation',
          status: 'active',
          createdAt: '2026-03-20T00:00:00.000Z',
          updatedAt: '2026-03-20T12:00:00.000Z',
          turnCount: 1,
          pendingInstructionCount: 0,
        },
      ],
      totalCount: 1,
    };
    const history: LoadTurnHistoryResponse = {
      turns: [
        {
          id: 'turn-1',
          conversationId: 'conv-1',
          position: 1,
          kind: 'operator',
          attribution: { type: 'operator', label: 'Operator' },
          instruction: 'Recovered transcript entry',
          status: 'completed',
          createdAt: '2026-03-20T12:00:00.000Z',
          completedAt: '2026-03-20T12:00:10.000Z',
        },
      ],
      totalCount: 1,
      hasMore: false,
    };
    let historyAttempts = 0;

    installFetchStub((url) => {
      if (url === '/conversations?status=active&limit=20') {
        return new Response(JSON.stringify(conversations), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url === '/conversations/conv-1/turns?limit=50') {
        historyAttempts += 1;
        if (historyAttempts === 1) {
          return new Response(JSON.stringify({ message: 'Temporary failure' }), {
            status: 503,
            statusText: 'Service Unavailable',
            headers: { 'Content-Type': 'application/json' },
          });
        }

        return new Response(JSON.stringify(history), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      throw new Error(`Unexpected fetch input: ${url}`);
    });

    render(<AppProviders />);

    expect(await screen.findByText('Failed to load transcript.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /retry transcript load/i }));

    expect(await screen.findByText('Recovered transcript entry')).toBeTruthy();
    expect(historyAttempts).toBe(2);
  });

  it('shows a loading indicator when loadState is loading', () => {
    render(<TranscriptPane entries={[]} loadState="loading" hasActiveConversation={true} />);

    expect(screen.getByText('Loading transcript…')).toBeTruthy();
  });

  it('shows an empty-entries message when conversation has no entries', () => {
    render(<TranscriptPane entries={[]} loadState="ready" hasActiveConversation={true} />);

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

    render(<TranscriptPane entries={entries} loadState="ready" hasActiveConversation={true} />);

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

    render(<TranscriptPane entries={entries} loadState="ready" hasActiveConversation={true} />);

    const articles = screen.getAllByRole('article');
    expect(articles).toHaveLength(3);
    expect(within(articles[0]).getByText('Alpha')).toBeTruthy();
    expect(within(articles[1]).getByText('Beta')).toBeTruthy();
    expect(within(articles[2]).getByText('Gamma')).toBeTruthy();
  });

  it('uses the transcript region role for the entries container', () => {
    render(<TranscriptPane entries={[]} loadState="ready" hasActiveConversation={true} />);

    expect(screen.getByRole('log')).toBeTruthy();
  });

  it('shows idle state (no entries message) when loadState is idle with active conversation', () => {
    render(<TranscriptPane entries={[]} loadState="idle" hasActiveConversation={true} />);

    expect(screen.getByText('No messages yet.')).toBeTruthy();
  });

  it('shows error state when loadState is error', () => {
    render(<TranscriptPane entries={[]} loadState="error" hasActiveConversation={true} />);

    expect(screen.getByText('Failed to load transcript.')).toBeTruthy();
  });

  // eslint-disable-next-line max-lines-per-function
  it('submits continue-mode instruction and refreshes conversation list', async () => {
    const conversations: ListConversationsResponse = {
      conversations: [
        {
          id: 'conv-1',
          title: 'Primary conversation',
          status: 'active',
          createdAt: '2026-03-20T00:00:00.000Z',
          updatedAt: '2026-03-20T12:00:00.000Z',
          turnCount: 1,
          pendingInstructionCount: 0,
        },
      ],
      totalCount: 1,
    };
    const initialHistory: LoadTurnHistoryResponse = {
      turns: [
        {
          id: 'turn-1',
          conversationId: 'conv-1',
          position: 1,
          kind: 'operator',
          attribution: { type: 'operator', label: 'Operator' },
          instruction: 'Initial instruction',
          status: 'completed',
          createdAt: '2026-03-20T12:00:00.000Z',
          completedAt: '2026-03-20T12:00:10.000Z',
        },
      ],
      totalCount: 1,
      hasMore: false,
    };
    const submitResponse = {
      turn: {
        id: 'turn-2',
        conversationId: 'conv-1',
        position: 2,
        kind: 'operator',
        attribution: { type: 'operator', label: 'Operator' },
        instruction: 'Follow-up instruction',
        status: 'submitted',
        createdAt: '2026-03-20T12:01:00.000Z',
      },
      streamId: 'stream-2',
    };

    let submitCalled = false;
    let listCallCount = 0;
    installFetchStub((url, init) => {
      if (url === '/conversations?status=active&limit=20') {
        listCallCount++;
        return new Response(JSON.stringify(conversations), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url === '/conversations/conv-1/turns?limit=50') {
        return new Response(JSON.stringify(initialHistory), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url === '/conversations/conv-1/turns' && init?.method === 'POST') {
        submitCalled = true;
        return new Response(JSON.stringify(submitResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      throw new Error(`Unexpected fetch input: ${url}`);
    });

    render(<AppProviders />);

    expect(await screen.findByText('Initial instruction')).toBeTruthy();

    fireEvent.change(screen.getByRole('textbox', { name: /instruction/i }), {
      target: { value: 'Follow-up instruction' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    // Submit POST was made; transcript update now arrives via WS streaming
    // (not via REST refresh) to prevent in-flight clobber.
    await vi.waitFor(() => {
      expect(submitCalled).toBe(true);
    });

    // Conversation list should refresh post-submit
    await vi.waitFor(() => {
      expect(listCallCount).toBeGreaterThanOrEqual(2);
    });
  });
});

// ─── TranscriptTurn streaming ───────────────────────────────────────────────

// eslint-disable-next-line max-lines-per-function
describe('TranscriptTurn streaming', () => {
  it('renders a streaming indicator for entries with status "streaming"', () => {
    const entry = createEntry({ status: 'streaming' });

    render(<TranscriptTurn entry={entry} />);

    expect(screen.getByText('streaming…')).toBeTruthy();
    const article = screen.getByRole('article');
    expect(article.getAttribute('data-streaming')).toBe('true');
  });

  it('does not render streaming indicator for completed entries', () => {
    const entry = createEntry({ status: 'completed' });

    render(<TranscriptTurn entry={entry} />);

    expect(screen.queryByText('streaming…')).toBeNull();
    const article = screen.getByRole('article');
    expect(article.getAttribute('data-streaming')).toBeNull();
  });

  it('renders status-kind content blocks with italic styling', () => {
    const entry = createEntry({
      contentBlocks: [
        { blockId: 'blk-status', kind: 'status', text: 'Agent is thinking…', metadata: null },
      ],
    });

    render(<TranscriptTurn entry={entry} />);

    const el = screen.getByText('Agent is thinking…');
    expect(el).toBeTruthy();
    // SafeText wraps text in <span> inside the <p> container
    expect(el.closest('p')).toBeTruthy();
  });

  it('renders text blocks alongside status blocks in order', () => {
    const entry = createEntry({
      status: 'streaming',
      contentBlocks: [
        textBlock('Partial response', 'blk-text'),
        { blockId: 'blk-status', kind: 'status', text: 'Processing…', metadata: null },
      ],
    });

    render(<TranscriptTurn entry={entry} />);

    expect(screen.getByText('Partial response')).toBeTruthy();
    expect(screen.getByText('Processing…')).toBeTruthy();
  });

  it('renders artifact references when present', () => {
    const entry = createEntry({
      artifacts: [
        { artifactId: 'art-1', kind: 'file', label: 'src/index.ts', availability: 'listed' },
        { artifactId: 'art-2', kind: 'diff', label: 'package.json', availability: 'ready' },
      ],
    });

    render(<TranscriptTurn entry={entry} />);

    const list = screen.getByTestId('artifact-list');
    expect(list).toBeTruthy();
    const badges = screen.getAllByTestId('artifact-badge');
    expect(badges.length).toBe(2);
    expect(screen.getByText('src/index.ts')).toBeTruthy();
    expect(screen.getByText('package.json')).toBeTruthy();
    expect(screen.getByText('file')).toBeTruthy();
    expect(screen.getByText('diff')).toBeTruthy();
  });

  it('does not render artifact list when artifacts is empty', () => {
    const entry = createEntry({ artifacts: [] });

    render(<TranscriptTurn entry={entry} />);

    expect(screen.queryByTestId('artifact-list')).toBeNull();
  });

  it('renders a pending approval prompt', () => {
    const entry = createEntry({
      prompt: {
        promptId: 'approval-1',
        parentTurnId: 'turn-1',
        status: 'pending',
        allowedResponses: [],
        contextBlocks: [],
        lastResponseSummary: null,
        errorMessage: null,
      },
    });

    render(<TranscriptTurn entry={entry} />);

    const promptEl = screen.getByTestId('approval-prompt');
    expect(promptEl).toBeTruthy();
    expect(promptEl.getAttribute('data-prompt-status')).toBe('pending');
    expect(screen.getByText('⏳ Approval pending')).toBeTruthy();
  });

  it('renders a resolved approval prompt with response summary', () => {
    const entry = createEntry({
      prompt: {
        promptId: 'approval-2',
        parentTurnId: 'turn-1',
        status: 'resolved',
        allowedResponses: [],
        contextBlocks: [],
        lastResponseSummary: 'Approved with conditions',
        errorMessage: null,
      },
    });

    render(<TranscriptTurn entry={entry} />);

    const promptEl = screen.getByTestId('approval-prompt');
    expect(promptEl.getAttribute('data-prompt-status')).toBe('resolved');
    expect(screen.getByText('✓ Approval resolved')).toBeTruthy();
    expect(screen.getByText('Approved with conditions')).toBeTruthy();
  });

  it('does not render prompt section when prompt is null', () => {
    const entry = createEntry({ prompt: null });

    render(<TranscriptTurn entry={entry} />);

    expect(screen.queryByTestId('approval-prompt')).toBeNull();
  });

  it('applies activity-group styling for activity-group entries', () => {
    const entry = createEntry({
      kind: 'activity-group',
      contentBlocks: [
        { blockId: 'act-1', kind: 'status', text: 'Analyzing files…', metadata: null },
      ],
    });

    render(<TranscriptTurn entry={entry} />);

    const article = screen.getByRole('article');
    expect(article.getAttribute('data-entry-kind')).toBe('activity-group');
    expect(screen.getByText('Analyzing files…')).toBeTruthy();
  });

  it('applies system-status styling for system-status entries', () => {
    const entry = createEntry({
      kind: 'system-status',
      status: 'warning',
      contentBlocks: [
        { blockId: 'sys-1', kind: 'status', text: 'Rate limit approaching', metadata: null },
      ],
    });

    render(<TranscriptTurn entry={entry} />);

    const article = screen.getByRole('article');
    expect(article.getAttribute('data-entry-kind')).toBe('system-status');
    expect(screen.getByText('Rate limit approaching')).toBeTruthy();
  });

  it('renders a complete entry with content blocks, artifacts, and prompt', () => {
    const entry = createEntry({
      status: 'streaming',
      contentBlocks: [textBlock('Working on it...')],
      artifacts: [
        { artifactId: 'art-1', kind: 'file', label: 'output.txt', availability: 'listed' },
      ],
      prompt: {
        promptId: 'p-1',
        parentTurnId: 'turn-1',
        status: 'pending',
        allowedResponses: [],
        contextBlocks: [],
        lastResponseSummary: null,
        errorMessage: null,
      },
    });

    render(<TranscriptTurn entry={entry} />);

    // All three sections should be visible
    expect(screen.getByText('Working on it...')).toBeTruthy();
    expect(screen.getByTestId('artifact-list')).toBeTruthy();
    expect(screen.getByText('output.txt')).toBeTruthy();
    expect(screen.getByTestId('approval-prompt')).toBeTruthy();
  });
});
