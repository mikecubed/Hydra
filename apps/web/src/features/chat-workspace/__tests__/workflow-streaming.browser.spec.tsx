/**
 * Browser workflow specs — incremental text-delta streaming + stream failure.
 *
 * Covers:
 *   – incremental text-delta rendering in the active transcript
 *   – failure reason display when the stream fails
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

describe('workspace streaming workflows', () => {
  it('renders incremental text-delta events in the active transcript', async () => {
    installFetchStub((url) => {
      if (url === '/conversations?status=active&limit=20') {
        return jsonResponse({
          conversations: [conversation('conv-1', 'Streaming demo')],
          totalCount: 1,
        });
      }
      if (url === '/conversations/conv-1/turns?limit=50') {
        return jsonResponse(EMPTY_HISTORY);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<AppProviders />);

    await screen.findByRole('button', { name: /streaming demo/i });

    const ws = openAndSubscribe('conv-1');

    // stream-started → creates a new streaming entry
    act(() => {
      ws.simulateMessage(
        streamFrame('conv-1', 1, 'turn-s1', 'stream-started', { attribution: 'Claude' }),
      );
    });

    expect(await screen.findByText('streaming…')).toBeInTheDocument();

    // First text delta
    act(() => {
      ws.simulateMessage(streamFrame('conv-1', 2, 'turn-s1', 'text-delta', { text: 'Hello ' }));
    });

    expect(await screen.findByText(/Hello/)).toBeInTheDocument();

    // Second text delta (appends)
    act(() => {
      ws.simulateMessage(streamFrame('conv-1', 3, 'turn-s1', 'text-delta', { text: 'world!' }));
    });

    expect(await screen.findByText('Hello world!')).toBeInTheDocument();
    expect(screen.getByText('streaming…')).toBeInTheDocument();

    // stream-completed → entry transitions to completed
    act(() => {
      ws.simulateMessage(streamFrame('conv-1', 4, 'turn-s1', 'stream-completed', {}));
    });

    await vi.waitFor(() => {
      expect(screen.queryByText('streaming…')).not.toBeInTheDocument();
    });

    // Content persists after completion
    expect(screen.getByText('Hello world!')).toBeInTheDocument();
    expect(screen.getByText('completed')).toBeInTheDocument();

    // Transcript structure: single article with Claude attribution
    const articles = transcriptArticles();
    expect(articles).toHaveLength(1);
    expect(within(articles[0]).getByText('Claude')).toBeInTheDocument();
    expect(within(articles[0]).getByText('Hello world!')).toBeInTheDocument();
  });

  it('renders a failure reason when the stream fails', async () => {
    installFetchStub((url) => {
      if (url === '/conversations?status=active&limit=20') {
        return jsonResponse({
          conversations: [conversation('conv-1', 'Failing stream')],
          totalCount: 1,
        });
      }
      if (url === '/conversations/conv-1/turns?limit=50') {
        return jsonResponse(EMPTY_HISTORY);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<AppProviders />);
    await screen.findByRole('button', { name: /failing stream/i });

    const ws = openAndSubscribe('conv-1');

    act(() => {
      ws.simulateMessage(streamFrame('conv-1', 1, 'turn-f1', 'stream-started'));
      ws.simulateMessage(
        streamFrame('conv-1', 2, 'turn-f1', 'text-delta', { text: 'Partial output…' }),
      );
      ws.simulateMessage(
        streamFrame('conv-1', 3, 'turn-f1', 'stream-failed', {
          reason: 'Agent crashed unexpectedly',
        }),
      );
    });

    expect(await screen.findByText('Partial output…')).toBeInTheDocument();
    expect(screen.getByText('Agent crashed unexpectedly')).toBeInTheDocument();
    expect(screen.getByText('failed')).toBeInTheDocument();
    expect(screen.queryByText('streaming…')).not.toBeInTheDocument();
  });
});
