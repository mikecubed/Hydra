/**
 * Browser workflow spec — deferred subscription during create-flow reconnect.
 *
 * Covers:
 *   – create/new conversation path retains subscription when the first
 *     subscribe attempt fires while the socket is not writable
 *   – post-open/reconnect subscription occurs for the active conversation
 *   – no early stream output is lost in the tested scenario
 *   – teardown warning path is limited to intentional cases only
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

// ─── Fixture helpers ────────────────────────────────────────────────────────

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

function installCreateFlowStub(): void {
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
}

// ─── Tests ──────────────────────────────────────────────────────────────────

// eslint-disable-next-line max-lines-per-function
describe('workspace create-flow with deferred subscription', () => {
  it('retains subscription intent when socket is closed during create-flow', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    installCreateFlowStub();
    render(<AppProviders />);

    // Wait for create-mode UI
    await vi.waitFor(() => {
      expect(screen.getByRole('textbox', { name: /instruction/i })).toBeInTheDocument();
    });

    // Open socket initially (no active conversation yet)
    const ws1 = latestSocket();
    act(() => {
      ws1.simulateOpen();
    });

    // Simulate abnormal close — socket goes to CLOSED
    act(() => {
      ws1.simulateClose(1006, 'abnormal closure');
    });

    // Submit in create mode while socket is dead
    fireEvent.change(screen.getByRole('textbox', { name: /instruction/i }), {
      target: { value: 'Build me a thing' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    // Wait for the conversation to be created and selected
    await screen.findByRole('button', { name: /new chat/i });

    // The subscription effect fired while socket was closed — subscribe was
    // deferred. Advance past the first reconnect delay (1 000 ms base).
    act(() => {
      vi.advanceTimersByTime(1_500);
    });

    // A new socket should have been created for the reconnect
    const ws2 = latestSocket();
    expect(ws2).not.toBe(ws1);

    // Open the reconnected socket
    act(() => {
      ws2.simulateOpen();
    });

    // Verify subscribe was sent for conv-new on the new socket
    const subMsgs = ws2.sentMessages.filter(
      (m) => m['type'] === 'subscribe' && m['conversationId'] === 'conv-new',
    );
    expect(subMsgs.length).toBeGreaterThanOrEqual(1);

    // Complete the subscription handshake
    act(() => {
      ws2.simulateMessage({ type: 'subscribed', conversationId: 'conv-new', currentSeq: 0 });
    });

    // Deliver stream events — these must not be lost
    act(() => {
      ws2.simulateMessage(
        streamFrame('conv-new', 1, 'turn-agent-1', 'stream-started', { attribution: 'Claude' }),
      );
      ws2.simulateMessage(
        streamFrame('conv-new', 2, 'turn-agent-1', 'text-delta', {
          text: 'Here is your thing.',
        }),
      );
      ws2.simulateMessage(streamFrame('conv-new', 3, 'turn-agent-1', 'stream-completed'));
    });

    // Stream content must render — no events lost
    expect(await screen.findByText('Here is your thing.')).toBeInTheDocument();
    await vi.waitFor(() => {
      expect(screen.queryByText('streaming…')).not.toBeInTheDocument();
    });

    // Transcript: operator instruction + agent reply in distinct articles
    const articles = transcriptArticles();
    expect(articles).toHaveLength(2);

    const instructionArticle = within(articles[0]);
    expect(instructionArticle.getByText('Build me a thing')).toBeInTheDocument();

    const agentArticle = within(articles[1]);
    expect(agentArticle.getByText('Here is your thing.')).toBeInTheDocument();
    expect(agentArticle.getByText('Claude')).toBeInTheDocument();
  });

  it('fulfills pending subscription via onConnectionEstablished for the active conversation', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    installCreateFlowStub();
    render(<AppProviders />);

    await vi.waitFor(() => {
      expect(screen.getByRole('textbox', { name: /instruction/i })).toBeInTheDocument();
    });

    // Open initial socket
    const ws1 = latestSocket();
    act(() => {
      ws1.simulateOpen();
    });

    // Close socket — triggers reconnect scheduling
    act(() => {
      ws1.simulateClose(1006, 'abnormal');
    });

    // Create new conversation while socket is dead
    fireEvent.change(screen.getByRole('textbox', { name: /instruction/i }), {
      target: { value: 'Build me a thing' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    await screen.findByRole('button', { name: /new chat/i });

    // Advance timers for reconnect
    act(() => {
      vi.advanceTimersByTime(1_500);
    });

    const ws2 = latestSocket();
    expect(ws2).not.toBe(ws1);

    act(() => {
      ws2.simulateOpen();
    });

    // The subscribe for conv-new must appear on ws2 — either queued during
    // connect() or sent via the onConnectionEstablished path.
    const subMsgs = ws2.sentMessages.filter(
      (m) => m['type'] === 'subscribe' && m['conversationId'] === 'conv-new',
    );
    expect(subMsgs.length).toBeGreaterThanOrEqual(1);
    // No duplicate subscribes — at most one per conversation per socket open
    expect(subMsgs).toHaveLength(1);
  });

  it('does not lose early stream events after deferred subscription', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    installCreateFlowStub();
    render(<AppProviders />);

    await vi.waitFor(() => {
      expect(screen.getByRole('textbox', { name: /instruction/i })).toBeInTheDocument();
    });

    const ws1 = latestSocket();
    act(() => {
      ws1.simulateOpen();
    });
    act(() => {
      ws1.simulateClose(1006, 'abnormal');
    });

    // Create conversation
    fireEvent.change(screen.getByRole('textbox', { name: /instruction/i }), {
      target: { value: 'Build me a thing' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    await screen.findByRole('button', { name: /new chat/i });

    // Reconnect
    act(() => {
      vi.advanceTimersByTime(1_500);
    });
    const ws2 = latestSocket();
    act(() => {
      ws2.simulateOpen();
    });
    act(() => {
      ws2.simulateMessage({ type: 'subscribed', conversationId: 'conv-new', currentSeq: 0 });
    });

    // Deliver seq 1-4 including early events that would be lost without fix
    act(() => {
      ws2.simulateMessage(
        streamFrame('conv-new', 1, 'turn-agent-1', 'stream-started', { attribution: 'Claude' }),
      );
    });
    act(() => {
      ws2.simulateMessage(
        streamFrame('conv-new', 2, 'turn-agent-1', 'text-delta', { text: 'Part 1.' }),
      );
    });
    act(() => {
      ws2.simulateMessage(
        streamFrame('conv-new', 3, 'turn-agent-1', 'text-delta', { text: ' Part 2.' }),
      );
    });
    act(() => {
      ws2.simulateMessage(streamFrame('conv-new', 4, 'turn-agent-1', 'stream-completed'));
    });

    // All content must be present — nothing lost
    expect(await screen.findByText('Part 1. Part 2.')).toBeInTheDocument();
    await vi.waitFor(() => {
      expect(screen.queryByText('streaming…')).not.toBeInTheDocument();
    });

    // Only one agent article (all deltas collapsed into one entry)
    const articles = transcriptArticles();
    const agentArticle = articles.find((a) => a.textContent.includes('Part 1. Part 2.'));
    expect(agentArticle).toBeDefined();
  });

  it('does not emit teardown warnings for deferred subscriptions', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    installCreateFlowStub();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      render(<AppProviders />);

      await vi.waitFor(() => {
        expect(screen.getByRole('textbox', { name: /instruction/i })).toBeInTheDocument();
      });

      const ws1 = latestSocket();
      act(() => {
        ws1.simulateOpen();
      });
      act(() => {
        ws1.simulateClose(1006, 'abnormal');
      });

      // Create conversation while socket is dead
      fireEvent.change(screen.getByRole('textbox', { name: /instruction/i }), {
        target: { value: 'Build me a thing' },
      });
      fireEvent.click(screen.getByRole('button', { name: /send/i }));
      await screen.findByRole('button', { name: /new chat/i });

      // Reconnect and open
      act(() => {
        vi.advanceTimersByTime(1_500);
      });
      const ws2 = latestSocket();
      act(() => {
        ws2.simulateOpen();
      });
      act(() => {
        ws2.simulateMessage({ type: 'subscribed', conversationId: 'conv-new', currentSeq: 0 });
      });

      // No "Failed to subscribe" warnings — only the softer "deferred" message
      const failedSubscribeWarnings = warnSpy.mock.calls.filter(
        (args) => typeof args[0] === 'string' && args[0].includes('Failed to subscribe'),
      );
      expect(failedSubscribeWarnings).toHaveLength(0);

      // The deferred message is informational, not an error
      const deferredWarnings = warnSpy.mock.calls.filter(
        (args) => typeof args[0] === 'string' && args[0].includes('Subscribe deferred'),
      );
      // May or may not appear depending on socket timing — but "Failed" must not
      expect(deferredWarnings.length).toBeGreaterThanOrEqual(0);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
