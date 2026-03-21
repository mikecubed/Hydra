/**
 * Browser workflow spec — reconnect and resume after abnormal WebSocket close.
 *
 * Covers:
 *   – reconnect with exponential backoff after an abnormal close
 *   – resume subscription with lastAcknowledgedSeq
 *   – deduplication of replayed events by the reconciler
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
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
  latestSocket,
  transcriptArticles,
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

describe('workspace reconnect workflow', () => {
  it('reconnects with resume seq after an abnormal WebSocket close', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    installFetchStub((url) => {
      if (url === '/conversations?status=active&limit=20') {
        return jsonResponse({
          conversations: [conversation('conv-1', 'Resilient chat')],
          totalCount: 1,
        });
      }
      if (url === '/conversations/conv-1/turns?limit=50') {
        return jsonResponse(EMPTY_HISTORY);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<AppProviders />);

    await screen.findByRole('button', { name: /resilient chat/i });

    const ws1 = openAndSubscribe('conv-1', 0);

    // Deliver a couple of events so the resume cursor advances
    act(() => {
      ws1.simulateMessage(streamFrame('conv-1', 1, 'turn-r1', 'stream-started'));
      ws1.simulateMessage(
        streamFrame('conv-1', 2, 'turn-r1', 'text-delta', { text: 'Before disconnect' }),
      );
    });

    expect(await screen.findByText('Before disconnect')).toBeInTheDocument();

    // Abnormal close triggers reconnect logic
    act(() => {
      ws1.simulateClose(1006, 'abnormal closure');
    });

    // Advance past the first reconnect delay (1 000 ms base)
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

    // The hook should have re-subscribed with the resume cursor
    const subscribeMsgs = ws2.sentMessages.filter((m) => m['type'] === 'subscribe');
    expect(subscribeMsgs).toHaveLength(1);
    const sub = subscribeMsgs[0];
    expect(sub['conversationId']).toBe('conv-1');
    expect(sub['lastAcknowledgedSeq']).toBe(2);

    // Server replays seq 2 (duplicate) then delivers seq 3 (new)
    act(() => {
      ws2.simulateMessage({ type: 'subscribed', conversationId: 'conv-1', currentSeq: 2 });
    });
    act(() => {
      ws2.simulateMessage(
        streamFrame('conv-1', 2, 'turn-r1', 'text-delta', { text: 'Before disconnect' }),
      );
      ws2.simulateMessage(
        streamFrame('conv-1', 3, 'turn-r1', 'text-delta', { text: ' and after reconnect' }),
      );
      ws2.simulateMessage(streamFrame('conv-1', 4, 'turn-r1', 'stream-completed'));
    });

    // Content should be properly concatenated (no duplicate text)
    expect(await screen.findByText('Before disconnect and after reconnect')).toBeInTheDocument();
    await vi.waitFor(() => {
      expect(screen.queryByText('streaming…')).not.toBeInTheDocument();
    });

    // Dedup: single resumed article, no duplicate text
    const articles = transcriptArticles();
    expect(articles).toHaveLength(1);

    // "Before disconnect" text appears in exactly one content paragraph
    const paras = articles[0].querySelectorAll('p');
    const matching = Array.from(paras).filter((p) => p.textContent.includes('Before disconnect'));
    expect(matching).toHaveLength(1);
    expect(matching[0]).toHaveTextContent('Before disconnect and after reconnect');

    // Full concatenated text lives inside the single article
    expect(
      within(articles[0]).getByText('Before disconnect and after reconnect'),
    ).toBeInTheDocument();

    // Outbound: subscribe(resume) was the first message on ws2 with correct cursor
    expect(ws2.sentMessages[0]['type']).toBe('subscribe');
    expect(ws2.sentMessages[0]['lastAcknowledgedSeq']).toBe(2);
  });
});
