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

describe('workspace conversation-switching workflow', () => {
  it('preserves per-conversation streamed state across switches', async () => {
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

    // Stream content into conv-a
    act(() => {
      ws.simulateMessage(streamFrame('conv-a', 1, 'turn-a1', 'stream-started'));
      ws.simulateMessage(
        streamFrame('conv-a', 2, 'turn-a1', 'text-delta', { text: 'Alpha response' }),
      );
      ws.simulateMessage(streamFrame('conv-a', 3, 'turn-a1', 'stream-completed'));
    });

    expect(await screen.findByText('Alpha response')).toBeInTheDocument();

    // Switch to conv-b
    fireEvent.click(screen.getByRole('button', { name: /bravo/i }));

    await vi.waitFor(() => {
      expect(screen.getByText('Active conversation: Bravo')).toBeInTheDocument();
    });

    // Conv-a content should not be visible
    expect(screen.queryByText('Alpha response')).not.toBeInTheDocument();

    // Subscription lifecycle: cleanup fires unsubscribe(old) → new effect subscribes(new).
    // Exactly one unsubscribe for the previous conversation.
    const unsubA = ws.sentMessages.filter(
      (m) => m['type'] === 'unsubscribe' && m['conversationId'] === 'conv-a',
    );
    expect(unsubA).toHaveLength(1);

    const subB = ws.sentMessages.filter(
      (m) => m['type'] === 'subscribe' && m['conversationId'] === 'conv-b',
    );
    expect(subB).toHaveLength(1);

    // Unsubscribe(conv-a) must precede subscribe(conv-b) in the wire order
    const unsubAIdx = ws.sentMessages.findIndex(
      (m) => m['type'] === 'unsubscribe' && m['conversationId'] === 'conv-a',
    );
    const subBIdx = ws.sentMessages.findIndex(
      (m) => m['type'] === 'subscribe' && m['conversationId'] === 'conv-b',
    );
    expect(unsubAIdx).toBeLessThan(subBIdx);

    // Confirm subscribe to conv-b and stream its own content
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

    // Switch back to conv-a — its content should be preserved
    fireEvent.click(screen.getByRole('button', { name: /alpha/i }));

    expect(await screen.findByText('Alpha response')).toBeInTheDocument();
    expect(screen.queryByText('Bravo response')).not.toBeInTheDocument();
  });
});
