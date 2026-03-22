/**
 * Browser workflow specs — create-mode and continue-mode submit + streaming.
 *
 * Covers:
 *   – create-mode submit with live streaming into the new conversation
 *   – continue-mode submit with streaming appended after existing history
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { AppProviders } from '../../../app/providers.tsx';
import {
  FakeWebSocket,
  resetFakeWebSockets,
  fetchSpy,
  installFetchStub,
  jsonResponse,
  conversation,
  submitResponse,
  streamFrame,
  openAndSubscribe,
  latestSocket,
  transcriptArticles,
} from './browser-helpers.ts';

beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeWebSocket);
});

afterEach(() => {
  resetFakeWebSockets();
  fetchSpy.mockReset();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  cleanup();
});

// ─── Create-mode fixtures ───────────────────────────────────────────────────

const CREATED_CONV = conversation('conv-new', 'New chat');
const OPERATOR_TURN = {
  id: 'turn-new',
  conversationId: 'conv-new',
  position: 1,
  kind: 'operator',
  attribution: { type: 'operator', label: 'Operator' },
  instruction: 'Build me a thing',
  status: 'submitted',
  createdAt: '2026-07-01T00:00:01.000Z',
};

function installCreateModeStub(): { getListCallCount: () => number } {
  let listCallCount = 0;
  installFetchStub((url, init) => {
    if (url === '/conversations?status=active&limit=20') {
      listCallCount++;
      if (listCallCount <= 1) {
        return jsonResponse({ conversations: [], totalCount: 0 });
      }
      return jsonResponse({ conversations: [CREATED_CONV], totalCount: 1 });
    }
    if (url === '/conversations' && init?.method === 'POST') {
      return jsonResponse(CREATED_CONV);
    }
    if (url === '/conversations/conv-new/turns' && init?.method === 'POST') {
      return jsonResponse(submitResponse('conv-new', 'turn-new', 'Build me a thing'));
    }
    if (url === '/conversations/conv-new/turns?limit=50') {
      return jsonResponse({ turns: [OPERATOR_TURN], totalCount: 1, hasMore: false });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  return { getListCallCount: () => listCallCount };
}

// ─── Continue-mode fixtures ─────────────────────────────────────────────────

const EXISTING_TURN = {
  id: 'turn-1',
  conversationId: 'conv-1',
  position: 1,
  kind: 'operator',
  attribution: { type: 'operator', label: 'Operator' },
  instruction: 'Tell me about Hydra',
  response: 'Hydra is a multi-agent orchestrator.',
  status: 'completed',
  createdAt: '2026-07-01T00:00:00.000Z',
  completedAt: '2026-07-01T00:00:05.000Z',
};
const HISTORY_WITH_TURN = { turns: [EXISTING_TURN], totalCount: 1, hasMore: false };

function installContinueModeStub(): { getListCallCount: () => number } {
  let listCallCount = 0;
  installFetchStub((url, init) => {
    if (url === '/conversations?status=active&limit=20') {
      listCallCount++;
      return jsonResponse({
        conversations: [conversation('conv-1', 'Ongoing chat', { turnCount: 1 })],
        totalCount: 1,
      });
    }
    if (url === '/conversations/conv-1/turns?limit=50') {
      return jsonResponse(HISTORY_WITH_TURN);
    }
    if (url === '/conversations/conv-1/turns' && init?.method === 'POST') {
      return jsonResponse(submitResponse('conv-1', 'turn-2', 'Now add tests'));
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  return { getListCallCount: () => listCallCount };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('workspace create-mode submit', () => {
  it('creates a conversation and streams the agent response', async () => {
    installCreateModeStub();
    render(<AppProviders />);

    await vi.waitFor(() => {
      expect(screen.getByRole('textbox', { name: /instruction/i })).toBeInTheDocument();
    });
    act(() => {
      latestSocket().simulateOpen();
    });

    fireEvent.change(screen.getByRole('textbox', { name: /instruction/i }), {
      target: { value: 'Build me a thing' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await screen.findByRole('button', { name: /new chat/i });
    const ws = openAndSubscribe('conv-new');

    act(() => {
      ws.simulateMessage(
        streamFrame('conv-new', 1, 'turn-agent-1', 'stream-started', { attribution: 'Claude' }),
      );
    });
    expect(await screen.findByText('streaming…')).toBeInTheDocument();

    act(() => {
      ws.simulateMessage(
        streamFrame('conv-new', 2, 'turn-agent-1', 'text-delta', {
          text: 'Here is your thing.',
        }),
      );
      ws.simulateMessage(streamFrame('conv-new', 3, 'turn-agent-1', 'stream-completed'));
    });

    expect(await screen.findByText('Here is your thing.')).toBeInTheDocument();
    await vi.waitFor(() => {
      expect(screen.queryByText('streaming…')).not.toBeInTheDocument();
    });

    // Transcript ownership: operator instruction + agent reply in distinct articles
    const articles = transcriptArticles();
    expect(articles).toHaveLength(2);

    const instructionArticle = within(articles[0]);
    expect(instructionArticle.getByText('Build me a thing')).toBeInTheDocument();
    expect(instructionArticle.getByText('Operator')).toBeInTheDocument();

    const agentArticle = within(articles[1]);
    expect(agentArticle.getByText('Here is your thing.')).toBeInTheDocument();
    expect(agentArticle.getByText('Claude')).toBeInTheDocument();

    expect(instructionArticle.queryByText('Here is your thing.')).not.toBeInTheDocument();
    expect(agentArticle.queryByText('Build me a thing')).not.toBeInTheDocument();
  });
});

describe('workspace continue-mode submit', () => {
  it('appends streamed content after an existing transcript', async () => {
    const { getListCallCount } = installContinueModeStub();
    render(<AppProviders />);

    expect(await screen.findByText('Tell me about Hydra')).toBeInTheDocument();
    expect(screen.getByText('Hydra is a multi-agent orchestrator.')).toBeInTheDocument();

    const ws = openAndSubscribe('conv-1');

    fireEvent.change(screen.getByRole('textbox', { name: /instruction/i }), {
      target: { value: 'Now add tests' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await vi.waitFor(() => {
      expect(getListCallCount()).toBeGreaterThanOrEqual(2);
    });

    act(() => {
      ws.simulateMessage(
        streamFrame('conv-1', 1, 'turn-agent-2', 'stream-started', { attribution: 'Codex' }),
      );
      ws.simulateMessage(
        streamFrame('conv-1', 2, 'turn-agent-2', 'text-delta', {
          text: 'Tests added for all modules.',
        }),
      );
      ws.simulateMessage(streamFrame('conv-1', 3, 'turn-agent-2', 'stream-completed'));
    });

    expect(await screen.findByText('Tests added for all modules.')).toBeInTheDocument();
    expect(screen.getByText('Hydra is a multi-agent orchestrator.')).toBeInTheDocument();
    expect(screen.getByText('Tell me about Hydra')).toBeInTheDocument();

    // Transcript ownership: history turn + submitted instruction + streamed reply
    const articles = transcriptArticles();
    expect(articles).toHaveLength(3);

    const historyArticle = within(articles[0]);
    expect(historyArticle.getByText('Tell me about Hydra')).toBeInTheDocument();
    expect(historyArticle.getByText('Hydra is a multi-agent orchestrator.')).toBeInTheDocument();
    expect(historyArticle.getByText('Operator')).toBeInTheDocument();

    const submitArticle = within(articles[1]);
    expect(submitArticle.getByText('Now add tests')).toBeInTheDocument();
    expect(submitArticle.getByText('Operator')).toBeInTheDocument();

    const agentArticle = within(articles[2]);
    expect(agentArticle.getByText('Tests added for all modules.')).toBeInTheDocument();
    expect(agentArticle.getByText('Codex')).toBeInTheDocument();

    expect(historyArticle.queryByText('Tests added for all modules.')).not.toBeInTheDocument();
  });
});
