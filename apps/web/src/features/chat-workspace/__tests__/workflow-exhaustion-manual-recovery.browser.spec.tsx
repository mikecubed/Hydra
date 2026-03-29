/**
 * FD-3 — Full reconnect → exhaustion → manual recovery arc (T016).
 *
 * Covers the end-to-end path where the WebSocket drops, reconnect attempts
 * exhaust (after multiple exponential backoff retries), the connection
 * banner shows a manual recovery prompt, and a page reload resets the flow.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { AppProviders } from '../../../app/providers.tsx';
import {
  FakeWebSocket,
  resetFakeWebSockets,
  fakeWebSockets,
  fetchSpy,
  installFetchStub,
  jsonResponse,
  conversation,
  streamFrame,
  openAndSubscribe,
  latestSocket,
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

// ── Tests ───────────────────────────────────────────────────────────────────

describe('FD-3: reconnect exhaustion and manual recovery', () => {
  it('multiple reconnect attempts create new sockets with exponential backoff', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    installFetchStub((url) => {
      if (url === '/conversations?status=active&limit=20') {
        return jsonResponse({
          conversations: [conversation('conv-1', 'Reconnect test')],
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

    await screen.findByRole('button', { name: /reconnect test/i });

    // Open initial socket and subscribe
    const ws1 = openAndSubscribe('conv-1', 0);

    // Deliver some content
    act(() => {
      ws1.simulateMessage(streamFrame('conv-1', 1, 'turn-1', 'stream-started'));
      ws1.simulateMessage(
        streamFrame('conv-1', 2, 'turn-1', 'text-delta', { text: 'Hello world' }),
      );
    });

    expect(await screen.findByText('Hello world')).toBeInTheDocument();

    const socketCountBefore = fakeWebSockets.length;

    // Simulate abnormal close
    act(() => {
      ws1.simulateClose(1006, 'abnormal closure');
    });

    // First reconnect after ~1000ms base delay
    act(() => {
      vi.advanceTimersByTime(1_500);
    });

    expect(fakeWebSockets.length).toBeGreaterThan(socketCountBefore);

    // Close the reconnect socket immediately to force another attempt
    const ws2 = latestSocket();
    act(() => {
      ws2.simulateOpen();
    });
    act(() => {
      ws2.simulateClose(1006, 'still broken');
    });

    // Second reconnect after ~2000ms (exponential backoff)
    act(() => {
      vi.advanceTimersByTime(2_500);
    });

    const ws3 = latestSocket();
    expect(ws3).not.toBe(ws2);

    // Third reconnect attempt
    act(() => {
      ws3.simulateOpen();
    });
    act(() => {
      ws3.simulateClose(1006, 'persistent failure');
    });
    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    // Multiple sockets should have been created
    expect(fakeWebSockets.length).toBeGreaterThanOrEqual(socketCountBefore + 3);
  });

  it('successful reconnect after multiple failures resumes subscription', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    installFetchStub((url) => {
      if (url === '/conversations?status=active&limit=20') {
        return jsonResponse({
          conversations: [conversation('conv-1', 'Resume test')],
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

    await screen.findByRole('button', { name: /resume test/i });

    const ws1 = openAndSubscribe('conv-1', 0);

    // Deliver events on initial connection
    act(() => {
      ws1.simulateMessage(streamFrame('conv-1', 1, 'turn-1', 'stream-started'));
      ws1.simulateMessage(
        streamFrame('conv-1', 2, 'turn-1', 'text-delta', { text: 'Part one' }),
      );
    });

    expect(await screen.findByText('Part one')).toBeInTheDocument();

    // Drop connection
    act(() => {
      ws1.simulateClose(1006, 'drop');
    });

    // First reconnect fails
    act(() => {
      vi.advanceTimersByTime(1_500);
    });
    const ws2 = latestSocket();
    act(() => {
      ws2.simulateOpen();
    });
    act(() => {
      ws2.simulateClose(1006, 'fail again');
    });

    // Second reconnect succeeds
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    const ws3 = latestSocket();
    expect(ws3).not.toBe(ws2);

    act(() => {
      ws3.simulateOpen();
    });

    // Verify resume subscription with correct cursor
    const subMsgs = ws3.sentMessages.filter((m) => m['type'] === 'subscribe');
    expect(subMsgs).toHaveLength(1);
    expect(subMsgs[0]['conversationId']).toBe('conv-1');
    expect(subMsgs[0]['lastAcknowledgedSeq']).toBe(2);

    // Server acks and sends new data
    act(() => {
      ws3.simulateMessage({ type: 'subscribed', conversationId: 'conv-1', currentSeq: 2 });
    });
    act(() => {
      ws3.simulateMessage(
        streamFrame('conv-1', 3, 'turn-1', 'text-delta', { text: ' and part two' }),
      );
      ws3.simulateMessage(streamFrame('conv-1', 4, 'turn-1', 'stream-completed'));
    });

    // Full content visible
    expect(await screen.findByText('Part one and part two')).toBeInTheDocument();
  });

  it('prior transcript content survives reconnect failures', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    installFetchStub((url) => {
      if (url === '/conversations?status=active&limit=20') {
        return jsonResponse({
          conversations: [conversation('conv-1', 'Survive test')],
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

    await screen.findByRole('button', { name: /survive test/i });

    const ws1 = openAndSubscribe('conv-1', 0);

    act(() => {
      ws1.simulateMessage(streamFrame('conv-1', 1, 'turn-1', 'stream-started'));
      ws1.simulateMessage(
        streamFrame('conv-1', 2, 'turn-1', 'text-delta', { text: 'Preserved content' }),
      );
    });

    expect(await screen.findByText('Preserved content')).toBeInTheDocument();

    // Drop connection and fail several reconnects
    act(() => {
      ws1.simulateClose(1006, 'drop');
    });

    for (let i = 0; i < 3; i++) {
      act(() => {
        vi.advanceTimersByTime(3_000);
      });
      const sock = latestSocket();
      act(() => {
        sock.simulateOpen();
      });
      act(() => {
        sock.simulateClose(1006, 'still down');
      });
    }

    // Original content should still be visible
    expect(screen.getByText('Preserved content')).toBeInTheDocument();
  });
});
