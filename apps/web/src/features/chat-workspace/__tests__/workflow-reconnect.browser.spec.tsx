/**
 * Browser workflow spec — reconnect and resume after abnormal WebSocket close.
 *
 * Covers:
 *   – reconnect with exponential backoff after an abnormal close
 *   – resume subscription with lastAcknowledgedSeq
 *   – deduplication of replayed events by the reconciler
 *   – T024 regressions: multiple rapid reconnect cycles, resume cursor advancement,
 *     rapid deltas post-reconnect, and stable transcript convergence
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
      if (url === '/conversations/conv-1/approvals') {
        return jsonResponse({ approvals: [] });
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

  // T024 regression: two successive reconnect cycles must advance the resume
  // cursor correctly without duplicating transcript entries. Protects T023
  // reference-stability in applyStreamEventsToConversation and the reconciler
  // deduplication path.
  it('survives two successive reconnect cycles with correct resume cursors and no entry duplication', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    installFetchStub((url) => {
      if (url === '/conversations?status=active&limit=20') {
        return jsonResponse({
          conversations: [conversation('conv-1', 'Multi-reconnect')],
          totalCount: 1,
        });
      }
      if (url === '/conversations/conv-1/turns?limit=50') {
        return jsonResponse(EMPTY_HISTORY);
      }
      if (url === '/conversations/conv-1/approvals') {
        return jsonResponse({ approvals: [] });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<AppProviders />);
    await screen.findByRole('button', { name: /multi-reconnect/i });

    // ── Cycle 0: initial connection, deliver seq 1–3 ────────────────────
    const ws0 = openAndSubscribe('conv-1', 0);
    act(() => {
      ws0.simulateMessage(streamFrame('conv-1', 1, 'turn-m1', 'stream-started'));
      ws0.simulateMessage(
        streamFrame('conv-1', 2, 'turn-m1', 'text-delta', { text: 'Chunk-A' }),
      );
      ws0.simulateMessage(
        streamFrame('conv-1', 3, 'turn-m1', 'text-delta', { text: ' Chunk-B' }),
      );
    });
    expect(await screen.findByText('Chunk-A Chunk-B')).toBeInTheDocument();

    // ── Cycle 1: abnormal close → reconnect ─────────────────────────────
    act(() => {
      ws0.simulateClose(1006, 'first drop');
    });
    act(() => {
      vi.advanceTimersByTime(1_500);
    });

    const ws1 = latestSocket();
    expect(ws1).not.toBe(ws0);
    act(() => {
      ws1.simulateOpen();
    });

    // Resume cursor must be at seq 3
    const sub1 = ws1.sentMessages.filter((m) => m['type'] === 'subscribe');
    expect(sub1).toHaveLength(1);
    expect(sub1[0]['lastAcknowledgedSeq']).toBe(3);

    act(() => {
      ws1.simulateMessage({ type: 'subscribed', conversationId: 'conv-1', currentSeq: 3 });
    });
    // Server replays seq 3 (dup) then delivers seq 4 (new)
    act(() => {
      ws1.simulateMessage(
        streamFrame('conv-1', 3, 'turn-m1', 'text-delta', { text: ' Chunk-B' }),
      );
      ws1.simulateMessage(
        streamFrame('conv-1', 4, 'turn-m1', 'text-delta', { text: ' Chunk-C' }),
      );
    });

    expect(await screen.findByText('Chunk-A Chunk-B Chunk-C')).toBeInTheDocument();

    // ── Cycle 2: second abnormal close → reconnect ──────────────────────
    act(() => {
      ws1.simulateClose(1006, 'second drop');
    });
    act(() => {
      vi.advanceTimersByTime(1_500);
    });

    const ws2 = latestSocket();
    expect(ws2).not.toBe(ws1);
    act(() => {
      ws2.simulateOpen();
    });

    // Resume cursor must have advanced to seq 4
    const sub2 = ws2.sentMessages.filter((m) => m['type'] === 'subscribe');
    expect(sub2).toHaveLength(1);
    expect(sub2[0]['lastAcknowledgedSeq']).toBe(4);

    act(() => {
      ws2.simulateMessage({ type: 'subscribed', conversationId: 'conv-1', currentSeq: 4 });
    });
    act(() => {
      ws2.simulateMessage(
        streamFrame('conv-1', 5, 'turn-m1', 'text-delta', { text: ' Chunk-D' }),
      );
      ws2.simulateMessage(streamFrame('conv-1', 6, 'turn-m1', 'stream-completed'));
    });

    // Final convergence: all chunks visible, no duplicates
    const finalText = 'Chunk-A Chunk-B Chunk-C Chunk-D';
    expect(await screen.findByText(finalText)).toBeInTheDocument();
    await vi.waitFor(() => {
      expect(screen.queryByText('streaming…')).not.toBeInTheDocument();
    });

    // Single article — no duplication across reconnect cycles
    const articles = transcriptArticles();
    expect(articles).toHaveLength(1);

    // Each chunk appears exactly once in the concatenated text
    const allText = articles[0].textContent ?? '';
    expect(allText.split('Chunk-A').length - 1).toBe(1);
    expect(allText.split('Chunk-B').length - 1).toBe(1);
    expect(allText.split('Chunk-C').length - 1).toBe(1);
    expect(allText.split('Chunk-D').length - 1).toBe(1);
  });

  // T024 regression: many rapid text-deltas delivered immediately after reconnect
  // must each produce a visible DOM update. Protects against T023 reference-
  // stability no-ops incorrectly swallowing distinct deltas when the reducer's
  // early-return path evaluates entries as "unchanged".
  it('renders every rapid delta after reconnect without swallowing updates', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    installFetchStub((url) => {
      if (url === '/conversations?status=active&limit=20') {
        return jsonResponse({
          conversations: [conversation('conv-1', 'Rapid deltas')],
          totalCount: 1,
        });
      }
      if (url === '/conversations/conv-1/turns?limit=50') {
        return jsonResponse(EMPTY_HISTORY);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<AppProviders />);
    await screen.findByRole('button', { name: /rapid deltas/i });

    const ws1 = openAndSubscribe('conv-1', 0);
    act(() => {
      ws1.simulateMessage(streamFrame('conv-1', 1, 'turn-rd', 'stream-started'));
      ws1.simulateMessage(
        streamFrame('conv-1', 2, 'turn-rd', 'text-delta', { text: 'Init' }),
      );
    });
    expect(await screen.findByText('Init')).toBeInTheDocument();

    // Disconnect and reconnect
    act(() => {
      ws1.simulateClose(1006, 'drop');
    });
    act(() => {
      vi.advanceTimersByTime(1_500);
    });

    const ws2 = latestSocket();
    act(() => {
      ws2.simulateOpen();
    });
    act(() => {
      ws2.simulateMessage({ type: 'subscribed', conversationId: 'conv-1', currentSeq: 2 });
    });

    // Deliver the first half of the burst and assert the transcript updates
    // before completion, so buffered-at-end rendering cannot pass this test.
    act(() => {
      for (let i = 0; i < 4; i++) {
        ws2.simulateMessage(
          streamFrame('conv-1', 3 + i, 'turn-rd', 'text-delta', { text: ` w${String(i)}` }),
        );
      }
    });

    await vi.waitFor(() => {
      expect(screen.getByText('Init w0 w1 w2 w3')).toBeInTheDocument();
    });
    expect(screen.getByText('streaming…')).toBeInTheDocument();

    act(() => {
      for (let i = 4; i < 8; i++) {
        ws2.simulateMessage(
          streamFrame('conv-1', 3 + i, 'turn-rd', 'text-delta', { text: ` w${String(i)}` }),
        );
      }
      ws2.simulateMessage(streamFrame('conv-1', 11, 'turn-rd', 'stream-completed'));
    });

    // Every delta must be represented in the final DOM text
    await vi.waitFor(() => {
      expect(screen.queryByText('streaming…')).not.toBeInTheDocument();
    });

    const articles = transcriptArticles();
    expect(articles).toHaveLength(1);
    const rendered = articles[0].textContent ?? '';
    expect(rendered).toContain('Init');
    for (let i = 0; i < 8; i++) {
      expect(rendered).toContain(`w${String(i)}`);
    }

    // Verify the final concatenated text in one paragraph
    const paras = articles[0].querySelectorAll('p');
    const fullText = Array.from(paras, (p) => p.textContent).join('');
    expect(fullText).toBe('Init w0 w1 w2 w3 w4 w5 w6 w7');
  });

  // T024 regression: when two turns are interleaved across a reconnect the
  // transcript must show both in order with no duplication.  Protects the
  // reconciler's per-turn delta accumulation surviving socket replacement.
  it('preserves multi-turn transcript across reconnect without interleaving duplicates', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    installFetchStub((url) => {
      if (url === '/conversations?status=active&limit=20') {
        return jsonResponse({
          conversations: [conversation('conv-1', 'Multi-turn reconnect')],
          totalCount: 1,
        });
      }
      if (url === '/conversations/conv-1/turns?limit=50') {
        return jsonResponse(EMPTY_HISTORY);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<AppProviders />);
    await screen.findByRole('button', { name: /multi-turn reconnect/i });

    const ws1 = openAndSubscribe('conv-1', 0);

    // First turn completes before disconnect
    act(() => {
      ws1.simulateMessage(streamFrame('conv-1', 1, 'turn-t1', 'stream-started'));
      ws1.simulateMessage(
        streamFrame('conv-1', 2, 'turn-t1', 'text-delta', { text: 'Turn one done' }),
      );
      ws1.simulateMessage(streamFrame('conv-1', 3, 'turn-t1', 'stream-completed'));
    });
    expect(await screen.findByText('Turn one done')).toBeInTheDocument();

    // Second turn starts streaming, then disconnect occurs
    act(() => {
      ws1.simulateMessage(streamFrame('conv-1', 4, 'turn-t2', 'stream-started'));
      ws1.simulateMessage(
        streamFrame('conv-1', 5, 'turn-t2', 'text-delta', { text: 'Turn two partial' }),
      );
    });
    expect(await screen.findByText('Turn two partial')).toBeInTheDocument();

    // Disconnect
    act(() => {
      ws1.simulateClose(1006, 'mid-turn');
    });
    act(() => {
      vi.advanceTimersByTime(1_500);
    });

    // Reconnect
    const ws2 = latestSocket();
    act(() => {
      ws2.simulateOpen();
    });
    act(() => {
      ws2.simulateMessage({ type: 'subscribed', conversationId: 'conv-1', currentSeq: 5 });
    });

    // Continue second turn on new socket
    act(() => {
      ws2.simulateMessage(
        streamFrame('conv-1', 6, 'turn-t2', 'text-delta', { text: ' continued' }),
      );
      ws2.simulateMessage(streamFrame('conv-1', 7, 'turn-t2', 'stream-completed'));
    });

    await vi.waitFor(() => {
      expect(screen.queryByText('streaming…')).not.toBeInTheDocument();
    });

    // Two articles: turn-t1 and turn-t2, each appearing exactly once
    const articles = transcriptArticles();
    expect(articles).toHaveLength(2);

    expect(within(articles[0]).getByText('Turn one done')).toBeInTheDocument();
    expect(within(articles[1]).getByText('Turn two partial continued')).toBeInTheDocument();

    // No content from turn-t1 leaks into turn-t2 or vice versa
    expect(within(articles[0]).queryByText(/Turn two/)).not.toBeInTheDocument();
    expect(within(articles[1]).queryByText(/Turn one/)).not.toBeInTheDocument();
  });
});
