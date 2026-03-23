/**
 * Browser workflow spec — conversation switching with per-conversation state.
 *
 * Covers:
 *   – conversation switching without mixing per-conversation stream state
 *   – subscription lifecycle: unsubscribe(old) → subscribe(new)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AppProviders } from '../../../app/providers.tsx';
import {
  FakeWebSocket,
  resetFakeWebSockets,
  fetchSpy,
  installFetchStub,
  jsonResponse,
  conversation,
  streamFrame,
  openAndSubscribe,
  EMPTY_HISTORY,
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

function installRevisitApprovalScenario(): () => number {
  let convAApprovalFetches = 0;

  installFetchStub((url) => {
    if (url === '/conversations?status=active&limit=20') {
      return jsonResponse({
        conversations: [conversation('conv-a', 'Alpha'), conversation('conv-b', 'Bravo')],
        totalCount: 2,
      });
    }
    if (url === '/conversations/conv-a/turns?limit=50') {
      return jsonResponse({
        turns: [
          {
            id: 'turn-a1',
            conversationId: 'conv-a',
            position: 1,
            kind: 'system',
            attribution: { label: 'Codex' },
            response: 'Awaiting approval.',
            status: 'executing',
            createdAt: '2026-07-01T00:00:00.000Z',
          },
        ],
        hasMore: false,
      });
    }
    if (url === '/conversations/conv-b/turns?limit=50') {
      return jsonResponse(EMPTY_HISTORY);
    }
    if (url === '/conversations/conv-a/approvals') {
      convAApprovalFetches += 1;
      if (convAApprovalFetches === 1) {
        return jsonResponse({ approvals: [] });
      }
      return jsonResponse({
        approvals: [
          {
            id: 'approval-a1',
            turnId: 'turn-a1',
            status: 'pending',
            prompt: 'Approve the revisited change?',
            context: {},
            contextHash: 'ctx-a1',
            responseOptions: [
              { key: 'approve', label: 'Approve' },
              { key: 'deny', label: 'Deny' },
            ],
            createdAt: '2026-07-01T00:00:30.000Z',
          },
        ],
      });
    }
    if (url === '/conversations/conv-b/approvals') {
      return jsonResponse({ approvals: [] });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });

  return () => convAApprovalFetches;
}

function installRevisitApprovalFailureScenario(): () => number {
  let convAApprovalFetches = 0;

  installFetchStub((url) => {
    if (url === '/conversations?status=active&limit=20') {
      return jsonResponse({
        conversations: [conversation('conv-a', 'Alpha'), conversation('conv-b', 'Bravo')],
        totalCount: 2,
      });
    }
    if (url === '/conversations/conv-a/turns?limit=50') {
      return jsonResponse({
        turns: [
          {
            id: 'turn-a1',
            conversationId: 'conv-a',
            position: 1,
            kind: 'system',
            attribution: { label: 'Codex' },
            response: 'Awaiting approval.',
            status: 'executing',
            createdAt: '2026-07-01T00:00:00.000Z',
          },
        ],
        hasMore: false,
      });
    }
    if (url === '/conversations/conv-b/turns?limit=50') {
      return jsonResponse(EMPTY_HISTORY);
    }
    if (url === '/conversations/conv-a/approvals') {
      convAApprovalFetches += 1;
      if (convAApprovalFetches === 1) {
        return jsonResponse({ approvals: [] });
      }
      return jsonResponse(
        {
          ok: false,
          code: 'HTTP_ERROR',
          category: 'daemon',
          message: 'Service unavailable',
          httpStatus: 503,
        },
        503,
        'Service Unavailable',
      );
    }
    if (url === '/conversations/conv-b/approvals') {
      return jsonResponse({ approvals: [] });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });

  return () => convAApprovalFetches;
}

async function assertConversationSwitchingPreservesStreamState(): Promise<void> {
  installFetchStub((url) => {
    if (url === '/conversations?status=active&limit=20') {
      return jsonResponse({
        conversations: [conversation('conv-a', 'Alpha'), conversation('conv-b', 'Bravo')],
        totalCount: 2,
      });
    }
    if (url === '/conversations/conv-a/turns?limit=50') {
      return jsonResponse(EMPTY_HISTORY);
    }
    if (url === '/conversations/conv-b/turns?limit=50') {
      return jsonResponse(EMPTY_HISTORY);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });

  render(<AppProviders />);

  await screen.findByRole('button', { name: /alpha/i });
  expect(screen.getByText('Active conversation: Alpha')).toBeInTheDocument();

  const ws = openAndSubscribe('conv-a');

  act(() => {
    ws.simulateMessage(streamFrame('conv-a', 1, 'turn-a1', 'stream-started'));
    ws.simulateMessage(
      streamFrame('conv-a', 2, 'turn-a1', 'text-delta', { text: 'Alpha response' }),
    );
    ws.simulateMessage(streamFrame('conv-a', 3, 'turn-a1', 'stream-completed'));
  });

  expect(await screen.findByText('Alpha response')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /bravo/i }));

  await vi.waitFor(() => {
    expect(screen.getByText('Active conversation: Bravo')).toBeInTheDocument();
  });

  expect(screen.queryByText('Alpha response')).not.toBeInTheDocument();

  const unsubA = ws.sentMessages.filter(
    (message) => message['type'] === 'unsubscribe' && message['conversationId'] === 'conv-a',
  );
  expect(unsubA).toHaveLength(1);

  const subB = ws.sentMessages.filter(
    (message) => message['type'] === 'subscribe' && message['conversationId'] === 'conv-b',
  );
  expect(subB).toHaveLength(1);

  const unsubAIdx = ws.sentMessages.findIndex(
    (message) => message['type'] === 'unsubscribe' && message['conversationId'] === 'conv-a',
  );
  const subBIdx = ws.sentMessages.findIndex(
    (message) => message['type'] === 'subscribe' && message['conversationId'] === 'conv-b',
  );
  expect(unsubAIdx).toBeLessThan(subBIdx);

  act(() => {
    ws.simulateMessage({ type: 'subscribed', conversationId: 'conv-b', currentSeq: 0 });
  });
  act(() => {
    ws.simulateMessage(streamFrame('conv-b', 1, 'turn-b1', 'stream-started'));
    ws.simulateMessage(
      streamFrame('conv-b', 2, 'turn-b1', 'text-delta', { text: 'Bravo response' }),
    );
    ws.simulateMessage(streamFrame('conv-b', 3, 'turn-b1', 'stream-completed'));
  });

  expect(await screen.findByText('Bravo response')).toBeInTheDocument();
  expect(screen.queryByText('Alpha response')).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /alpha/i }));

  expect(await screen.findByText('Alpha response')).toBeInTheDocument();
  expect(screen.queryByText('Bravo response')).not.toBeInTheDocument();
}

async function assertApprovalsRefreshOnRevisit(): Promise<void> {
  const getConvAApprovalFetches = installRevisitApprovalScenario();

  render(<AppProviders />);

  await screen.findByRole('button', { name: /alpha/i });
  expect(screen.queryByTestId('approval-prompt')).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /bravo/i }));
  await vi.waitFor(() => {
    expect(screen.getByText('Active conversation: Bravo')).toBeInTheDocument();
  });

  fireEvent.click(screen.getByRole('button', { name: /alpha/i }));
  expect(await screen.findByText('Approve the revisited change?')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
  expect(getConvAApprovalFetches()).toBe(2);
}

async function assertRevisitFailureDoesNotShowLoadingIndicator(): Promise<void> {
  const getConvAApprovalFetches = installRevisitApprovalFailureScenario();

  render(<AppProviders />);

  await screen.findByRole('button', { name: /alpha/i });
  await screen.findByText('Awaiting approval.');

  fireEvent.click(screen.getByRole('button', { name: /bravo/i }));
  await vi.waitFor(() => {
    expect(screen.getByText('Active conversation: Bravo')).toBeInTheDocument();
  });

  fireEvent.click(screen.getByRole('button', { name: /alpha/i }));
  await vi.waitFor(() => {
    expect(screen.getByText('Active conversation: Alpha')).toBeInTheDocument();
  });
  expect(screen.queryByText('Loading transcript…')).not.toBeInTheDocument();
  expect(screen.getByText('Awaiting approval.')).toBeInTheDocument();
  expect(getConvAApprovalFetches()).toBe(2);
}

describe('workspace conversation-switching workflow', () => {
  it('preserves per-conversation streamed state across switches', async () => {
    await assertConversationSwitchingPreservesStreamState();
  });

  it('refreshes approvals when revisiting a conversation', async () => {
    await assertApprovalsRefreshOnRevisit();
  });

  it('does not show loading indicator when revisiting a conversation with loaded history and approval refresh fails', async () => {
    await assertRevisitFailureDoesNotShowLoadingIndicator();
  });
});
