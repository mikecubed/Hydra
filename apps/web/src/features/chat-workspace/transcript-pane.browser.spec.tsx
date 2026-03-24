import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ListConversationsResponse, LoadTurnHistoryResponse } from '@hydra/web-contracts';

import { AppProviders } from '../../app/providers.tsx';
import { TranscriptPane } from './components/transcript-pane.tsx';
import { TranscriptTurn } from './components/transcript-turn.tsx';
import type {
  TranscriptEntryState,
  ContentBlockState,
  WorkspaceStore,
} from './model/workspace-store.ts';
import {
  FakeWebSocket,
  openAndSubscribe,
  resetFakeWebSockets,
  streamFrame,
} from './__tests__/browser-helpers.ts';

// Capture the workspace store created during render so tests can dispatch
// actions (e.g. seeding entry controls) that aren't reachable through DOM
// interaction alone.
let _capturedStore: WorkspaceStore | null = null;

vi.mock('./model/workspace-store.ts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./model/workspace-store.ts')>();
  return {
    ...mod,
    createWorkspaceStore: (...args: Parameters<typeof mod.createWorkspaceStore>) => {
      const store = mod.createWorkspaceStore(...args);
      _capturedStore = store;
      return store;
    },
  };
});

const fetchSpy = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeWebSocket);
});

afterEach(() => {
  _capturedStore = null;
  fetchSpy.mockReset();
  resetFakeWebSockets();
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

function createSingleConversationList(): ListConversationsResponse {
  return {
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
}

function createSingleTurnHistory(responseText: string): LoadTurnHistoryResponse {
  return {
    turns: [
      {
        id: 'turn-1',
        conversationId: 'conv-1',
        position: 1,
        kind: 'system',
        attribution: { type: 'agent', agentId: 'codex', label: 'Codex' },
        response: responseText,
        status: 'executing',
        createdAt: '2026-03-20T12:00:31.000Z',
        completedAt: '2026-03-20T12:00:45.000Z',
      },
    ],
    totalCount: 1,
    hasMore: false,
  };
}

function installApprovalRetryScenario(): () => number {
  const conversations = createSingleConversationList();
  const history = createSingleTurnHistory('Waiting for approval before continuing.');
  let approvalCalls = 0;

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
      approvalCalls += 1;
      if (approvalCalls === 1) {
        return new Response(
          JSON.stringify({
            ok: false,
            code: 'HTTP_ERROR',
            category: 'daemon',
            message: 'Service unavailable',
            httpStatus: 503,
          }),
          {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }

      return new Response(
        JSON.stringify({
          approvals: [
            {
              id: 'approval-1',
              turnId: 'turn-1',
              status: 'pending',
              prompt: 'Approve the recovered request?',
              context: {},
              contextHash: 'ctx-1',
              responseOptions: [{ key: 'approve', label: 'Approve' }],
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

  return () => approvalCalls;
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

      if (url === '/conversations/conv-1/approvals') {
        return new Response(JSON.stringify({ approvals: [] }), {
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

    expect(await screen.findByText('Approve the proposed file changes?')).toBeInTheDocument();
    expect(screen.getByTestId('approval-prompt')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeInTheDocument();
  });

  it('retries pending approval hydration after a transient approval fetch failure', async () => {
    const getApprovalCalls = installApprovalRetryScenario();

    render(<AppProviders />);

    expect(await screen.findByText('Waiting for approval before continuing.')).toBeInTheDocument();
    expect(screen.queryByTestId('approval-prompt')).toBeNull();

    await screen.findByText('Approve the recovered request?', undefined, { timeout: 3000 });
    expect(screen.getByTestId('approval-prompt')).toBeInTheDocument();
    expect(getApprovalCalls()).toBe(2);
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

  it('windows the live workspace to the most recent loaded entries for large transcripts', async () => {
    const conversations: ListConversationsResponse = {
      conversations: [
        {
          id: 'conv-1',
          title: 'Primary conversation',
          status: 'active',
          createdAt: '2026-03-20T00:00:00.000Z',
          updatedAt: '2026-03-20T12:00:00.000Z',
          turnCount: 51,
          pendingInstructionCount: 0,
        },
      ],
      totalCount: 1,
    };
    const history: LoadTurnHistoryResponse = {
      turns: Array.from({ length: 51 }, (_, index) => {
        const entryNumber = String(index + 1);
        const minuteText = String(index).padStart(2, '0');
        return {
          id: `turn-${entryNumber}`,
          conversationId: 'conv-1',
          position: index + 1,
          kind: 'system' as const,
          attribution: { type: 'agent' as const, agentId: 'codex', label: 'Codex' },
          response: `Historical entry ${entryNumber}`,
          status: 'completed' as const,
          createdAt: `2026-03-20T12:${minuteText}:00.000Z`,
          completedAt: `2026-03-20T12:${minuteText}:30.000Z`,
        };
      }),
      totalCount: 51,
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

    expect(await screen.findByText('Historical entry 51')).toBeInTheDocument();
    expect(screen.queryByText('Historical entry 1')).toBeNull();
    expect(screen.getByTestId('transcript-orientation')).toHaveTextContent(
      'Showing the most recent 50 of 51 loaded entries.',
    );
  });

  it('surfaces a stale-control banner after authoritative convergence invalidates controls', async () => {
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
    const authoritativeHistory: LoadTurnHistoryResponse = {
      turns: [
        {
          id: 'turn-1',
          conversationId: 'conv-1',
          position: 1,
          kind: 'system',
          attribution: { type: 'agent', agentId: 'codex', label: 'Codex' },
          response: 'Resumed by another session',
          status: 'completed',
          createdAt: '2026-03-20T12:00:31.000Z',
          completedAt: '2026-03-20T12:00:45.000Z',
        },
      ],
      totalCount: 1,
      hasMore: false,
    };

    let resolveHistory = (_value: Response): void => {
      throw new Error('Expected the transcript history request to be pending');
    };

    fetchSpy.mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === '/conversations?status=active&limit=20') {
        return Promise.resolve(
          new Response(JSON.stringify(conversations), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }

      if (url === '/conversations/conv-1/turns?limit=50') {
        return new Promise<Response>((resolve) => {
          resolveHistory = resolve;
        });
      }

      if (url === '/conversations/conv-1/approvals') {
        return Promise.resolve(
          new Response(JSON.stringify({ approvals: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }

      throw new Error(`Unexpected fetch input: ${url}`);
    });
    vi.stubGlobal('fetch', fetchSpy);

    render(<AppProviders />);
    await screen.findByRole('button', { name: /primary conversation/i });

    const ws = openAndSubscribe('conv-1');
    ws.simulateMessage(
      streamFrame('conv-1', 1, 'turn-1', 'stream-started', { attribution: 'Codex' }),
    );
    ws.simulateMessage(
      streamFrame('conv-1', 2, 'turn-1', 'status-change', { status: 'submitted' }),
    );

    // Seed a cancel control on the stream entry so the authoritative merge has
    // something to actually invalidate.  Without entry-level controls the
    // reducer correctly suppresses staleReason (reference-equality fast path).
    act(() => {
      _capturedStore!.dispatch({
        type: 'entry/update-controls',
        conversationId: 'conv-1',
        entryId: 'turn-1',
        controls: [
          { controlId: 'ctrl-cancel', kind: 'cancel', enabled: true, reasonDisabled: null },
        ],
      });
    });

    resolveHistory(
      new Response(JSON.stringify(authoritativeHistory), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    expect(await screen.findByText('State changed by another session')).toBeInTheDocument();
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

    expect(await screen.findByText('Recovered transcript entry')).toBeInTheDocument();
    expect(historyAttempts).toBe(2);
  });

  // eslint-disable-next-line max-lines-per-function
  it('disables send while transcript sync is pending or failed, then re-enables after recovery', async () => {
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

    let resolveFirstHistory: ((response: Response) => void) | undefined;
    let historyAttempts = 0;

    fetchSpy.mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === '/conversations?status=active&limit=20') {
        return Promise.resolve(
          new Response(JSON.stringify(conversations), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }

      if (url === '/conversations/conv-1/turns?limit=50') {
        historyAttempts += 1;
        if (historyAttempts === 1) {
          return new Promise<Response>((resolve) => {
            resolveFirstHistory = resolve;
          });
        }

        return Promise.resolve(
          new Response(JSON.stringify(history), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }

      throw new Error(`Unexpected fetch input: ${url}`);
    });
    vi.stubGlobal('fetch', fetchSpy);

    render(<AppProviders />);
    await screen.findByRole('button', { name: /primary conversation/i });
    openAndSubscribe('conv-1');

    const instructionBox = screen.getByRole('textbox', { name: /instruction/i });
    const sendButton = screen.getByRole('button', { name: /send/i });
    fireEvent.change(instructionBox, { target: { value: 'Follow-up instruction' } });

    expect(await screen.findByRole('status')).toHaveTextContent(/synchronizing workspace/i);
    expect(sendButton.getAttribute('disabled')).not.toBeNull();

    resolveFirstHistory?.(
      new Response(JSON.stringify({ message: 'Temporary failure' }), {
        status: 503,
        statusText: 'Service Unavailable',
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    expect(await screen.findAllByText(/sync error — transcript may be stale/i)).toHaveLength(2);
    expect(sendButton.getAttribute('disabled')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /retry transcript load/i }));

    expect(await screen.findByText('Recovered transcript entry')).toBeInTheDocument();
    await vi.waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.queryByRole('status')).toBeNull();
      expect(sendButton.getAttribute('disabled')).toBeNull();
    });
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
  it('renders lineage for a branched conversation selected from turn controls', async () => {
    const primaryConversation = {
      id: 'conv-1',
      title: 'Primary conversation',
      status: 'active' as const,
      createdAt: '2026-03-20T00:00:00.000Z',
      updatedAt: '2026-03-20T12:00:00.000Z',
      turnCount: 1,
      pendingInstructionCount: 0,
    };
    const branchConversation = {
      id: 'conv-branch',
      title: 'Branch conversation',
      status: 'active' as const,
      createdAt: '2026-03-20T12:05:00.000Z',
      updatedAt: '2026-03-20T12:05:00.000Z',
      turnCount: 0,
      pendingInstructionCount: 0,
      parentConversationId: 'conv-1',
      forkPointTurnId: 'turn-1',
    };
    const initialHistory: LoadTurnHistoryResponse = {
      turns: [
        {
          id: 'turn-1',
          conversationId: 'conv-1',
          position: 1,
          kind: 'operator',
          attribution: { type: 'operator', label: 'Operator' },
          instruction: 'Original branch point',
          status: 'completed',
          createdAt: '2026-03-20T12:00:00.000Z',
          completedAt: '2026-03-20T12:00:10.000Z',
        },
      ],
      totalCount: 1,
      hasMore: false,
    };

    let listCalls = 0;
    installFetchStub((url, init) => {
      if (url === '/conversations?status=active&limit=20') {
        listCalls += 1;
        return new Response(
          JSON.stringify({
            conversations:
              listCalls === 1 ? [primaryConversation] : [branchConversation, primaryConversation],
            totalCount: listCalls === 1 ? 1 : 2,
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }

      if (url === '/conversations/conv-1/turns?limit=50') {
        return new Response(JSON.stringify(initialHistory), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url === '/conversations/conv-branch/turns?limit=50') {
        return new Response(
          JSON.stringify({
            turns: [],
            totalCount: 0,
            hasMore: false,
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }

      if (
        url === '/conversations/conv-1/approvals' ||
        url === '/conversations/conv-branch/approvals'
      ) {
        return new Response(JSON.stringify({ approvals: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url === '/conversations' && init?.method === 'POST') {
        return new Response(JSON.stringify(branchConversation), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      throw new Error(`Unexpected fetch input: ${url}`);
    });

    render(<AppProviders />);

    expect(await screen.findByText('Original branch point')).toBeInTheDocument();

    fireEvent.click(await screen.findByTestId('turn-action-branch'));

    expect(
      await screen.findByText(/active conversation: branch conversation/i),
    ).toBeInTheDocument();
    expect(screen.getByTestId('lineage-badge')).toHaveTextContent('branch');
    expect(screen.getByTestId('lineage-badge')).toHaveTextContent('conv-1');
    expect(screen.getByTestId('lineage-badge')).toHaveTextContent('@turn-1');
  });

  it('focuses the composer and surfaces follow-up context from turn controls', async () => {
    installFetchStub((url) => {
      if (url === '/conversations?status=active&limit=20') {
        return new Response(JSON.stringify(createSingleConversationList()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url === '/conversations/conv-1/turns?limit=50') {
        return new Response(
          JSON.stringify({
            turns: [
              {
                id: 'turn-1',
                conversationId: 'conv-1',
                position: 1,
                kind: 'operator',
                attribution: { type: 'operator', label: 'Operator' },
                instruction: 'Completed turn',
                status: 'completed',
                createdAt: '2026-03-20T12:00:00.000Z',
                completedAt: '2026-03-20T12:00:10.000Z',
              },
            ],
            totalCount: 1,
            hasMore: false,
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }

      if (url === '/conversations/conv-1/approvals') {
        return new Response(JSON.stringify({ approvals: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      throw new Error(`Unexpected fetch input: ${url}`);
    });

    render(<AppProviders />);

    expect(await screen.findByText('Completed turn')).toBeInTheDocument();
    openAndSubscribe('conv-1');
    const composer = screen.getByRole('textbox', { name: /instruction/i });
    screen.getByRole('button', { name: /primary conversation/i }).focus();
    fireEvent.click(await screen.findByTestId('turn-action-follow-up'));

    await vi.waitFor(() => {
      expect(composer).toHaveFocus();
    });
  });

  // eslint-disable-next-line max-lines-per-function
  it('reconciles the cancelled turn immediately from the control response', async () => {
    const historyResponses: LoadTurnHistoryResponse[] = [
      {
        turns: [
          {
            id: 'turn-1',
            conversationId: 'conv-1',
            position: 1,
            kind: 'system',
            attribution: { type: 'agent', agentId: 'codex', label: 'Codex' },
            response: 'Working on it…',
            status: 'executing',
            createdAt: '2026-03-20T12:00:00.000Z',
          },
        ],
        totalCount: 1,
        hasMore: false,
      },
      {
        turns: [
          {
            id: 'turn-1',
            conversationId: 'conv-1',
            position: 1,
            kind: 'system',
            attribution: { type: 'agent', agentId: 'codex', label: 'Codex' },
            response: 'Cancelled by operator.',
            status: 'cancelled',
            createdAt: '2026-03-20T12:00:00.000Z',
            completedAt: '2026-03-20T12:00:05.000Z',
          },
        ],
        totalCount: 1,
        hasMore: false,
      },
    ];
    let historyCallCount = 0;
    let listCallCount = 0;

    installFetchStub((url, init) => {
      if (url === '/conversations?status=active&limit=20') {
        listCallCount += 1;
        return new Response(JSON.stringify(createSingleConversationList()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url === '/conversations/conv-1/turns?limit=50') {
        const response = historyResponses[Math.min(historyCallCount, historyResponses.length - 1)];
        historyCallCount += 1;
        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url === '/conversations/conv-1/approvals') {
        return new Response(JSON.stringify({ approvals: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url === '/conversations/conv-1/turns/turn-1/cancel' && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            success: true,
            turn: historyResponses[1].turns[0],
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

    expect(await screen.findByText('Working on it…')).toBeInTheDocument();
    const ws = openAndSubscribe('conv-1');
    ws.simulateMessage(
      streamFrame('conv-1', 1, 'turn-1', 'stream-started', { attribution: 'Codex' }),
    );

    fireEvent.click(await screen.findByTestId('turn-action-cancel'));

    expect(await screen.findByText('Cancelled by operator.')).toBeInTheDocument();
    expect(screen.getByText('cancelled')).toBeInTheDocument();
    await vi.waitFor(() => {
      expect(listCallCount).toBeGreaterThanOrEqual(2);
      expect(historyCallCount).toBeGreaterThanOrEqual(2);
    });
  });

  // eslint-disable-next-line max-lines-per-function
  it('appends the retried turn before the transcript background refresh finishes', async () => {
    const historyResponses: LoadTurnHistoryResponse[] = [
      {
        turns: [
          {
            id: 'turn-1',
            conversationId: 'conv-1',
            position: 1,
            kind: 'system',
            attribution: { type: 'agent', agentId: 'codex', label: 'Codex' },
            response: 'Original failure',
            status: 'failed',
            createdAt: '2026-03-20T12:00:00.000Z',
            completedAt: '2026-03-20T12:00:05.000Z',
          },
        ],
        totalCount: 1,
        hasMore: false,
      },
      {
        turns: [
          {
            id: 'turn-1',
            conversationId: 'conv-1',
            position: 1,
            kind: 'system',
            attribution: { type: 'agent', agentId: 'codex', label: 'Codex' },
            response: 'Original failure',
            status: 'failed',
            createdAt: '2026-03-20T12:00:00.000Z',
            completedAt: '2026-03-20T12:00:05.000Z',
          },
          {
            id: 'turn-2',
            conversationId: 'conv-1',
            position: 2,
            kind: 'operator',
            attribution: { type: 'operator', label: 'Operator' },
            instruction: 'Retry original request',
            status: 'submitted',
            createdAt: '2026-03-20T12:01:00.000Z',
          },
        ],
        totalCount: 2,
        hasMore: false,
      },
    ];
    let historyCallCount = 0;

    installFetchStub((url, init) => {
      if (url === '/conversations?status=active&limit=20') {
        return new Response(JSON.stringify(createSingleConversationList()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url === '/conversations/conv-1/turns?limit=50') {
        const response = historyResponses[Math.min(historyCallCount, historyResponses.length - 1)];
        historyCallCount += 1;
        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url === '/conversations/conv-1/approvals') {
        return new Response(JSON.stringify({ approvals: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url === '/conversations/conv-1/turns/turn-1/retry' && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            streamId: 'stream-2',
            turn: historyResponses[1].turns[1],
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

    expect(await screen.findByText('Original failure')).toBeInTheDocument();

    fireEvent.click(await screen.findByTestId('turn-action-retry'));

    expect(await screen.findByText('Retry original request')).toBeInTheDocument();
    await vi.waitFor(() => {
      expect(screen.getAllByRole('article')).toHaveLength(2);
      expect(historyCallCount).toBeGreaterThanOrEqual(2);
    });
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
    openAndSubscribe('conv-1');

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
        staleReason: null,
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
        staleReason: null,
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
        staleReason: null,
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

// ─── Large history orientation ──────────────────────────────────────────────

// eslint-disable-next-line max-lines-per-function
describe('TranscriptPane large history orientation', () => {
  it('shows hidden entry count when hiddenEntryCount is provided', () => {
    const entries = Array.from({ length: 5 }, (_, i) => {
      const indexText = String(i);
      return createEntry({
        entryId: `e-${indexText}`,
        turnId: `t-${indexText}`,
        contentBlocks: [textBlock(`Message ${indexText}`, `blk-${indexText}`)],
      });
    });

    render(
      <TranscriptPane
        entries={entries}
        loadState="ready"
        hasActiveConversation={true}
        hasMoreHistory={false}
        hiddenEntryCount={45}
      />,
    );

    const orientation = screen.getByTestId('transcript-orientation');
    expect(orientation).toBeTruthy();
    expect(orientation.textContent).toContain('5');
    expect(orientation.textContent).toContain('50');
  });

  it('shows combined orientation when both hasMoreHistory and hiddenEntryCount', () => {
    const entries = [
      createEntry({
        entryId: 'e-0',
        turnId: 't-0',
        contentBlocks: [textBlock('Latest message')],
      }),
    ];

    render(
      <TranscriptPane
        entries={entries}
        loadState="ready"
        hasActiveConversation={true}
        hasMoreHistory={true}
        hiddenEntryCount={20}
      />,
    );

    const orientation = screen.getByTestId('transcript-orientation');
    expect(orientation).toBeTruthy();
    // Should mention both hidden entries and server history
    expect(orientation.textContent).toContain('1');
    expect(orientation.textContent).toContain('21');
    expect(orientation.textContent).toMatch(/older history/i);
  });

  it('preserves existing hasMoreHistory message when no hiddenEntryCount', () => {
    const entries = [
      createEntry({
        entryId: 'e-0',
        turnId: 't-0',
        contentBlocks: [textBlock('Visible turn')],
      }),
    ];

    render(
      <TranscriptPane
        entries={entries}
        loadState="ready"
        hasActiveConversation={true}
        hasMoreHistory={true}
      />,
    );

    const orientation = screen.getByTestId('transcript-orientation');
    expect(orientation).toBeTruthy();
    expect(orientation.textContent).toMatch(/older history/i);
  });

  it('shows no orientation banner for small fully-loaded histories', () => {
    const entries = [
      createEntry({
        entryId: 'e-0',
        turnId: 't-0',
        contentBlocks: [textBlock('Only message')],
      }),
    ];

    render(
      <TranscriptPane
        entries={entries}
        loadState="ready"
        hasActiveConversation={true}
        hasMoreHistory={false}
        hiddenEntryCount={0}
      />,
    );

    expect(screen.queryByTestId('transcript-orientation')).toBeNull();
  });

  it('shows no orientation banner when hiddenEntryCount is omitted and hasMoreHistory is false', () => {
    const entries = [
      createEntry({
        entryId: 'e-0',
        turnId: 't-0',
        contentBlocks: [textBlock('Message')],
      }),
    ];

    render(
      <TranscriptPane
        entries={entries}
        loadState="ready"
        hasActiveConversation={true}
        hasMoreHistory={false}
      />,
    );

    expect(screen.queryByTestId('transcript-orientation')).toBeNull();
  });
});
