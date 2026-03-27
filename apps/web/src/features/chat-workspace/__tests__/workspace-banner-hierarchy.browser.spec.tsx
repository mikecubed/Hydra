/**
 * Verifies connection banner renders inside WorkspaceRoute (the real route
 * hierarchy), NOT in AppShell. Guards against the provider/consumer mismatch
 * where AppShell (root layout) tried to read a context provided by a child
 * route.
 *
 * This test renders through AppProviders → Router → AppShell → WorkspaceRoute
 * so any hierarchy bugs surface immediately.
 *
 * useSession is mocked globally in test-setup.ts — no session WebSocket is
 * created, so latestSocket() always returns the chat-protocol WebSocket.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { AppProviders } from '../../../app/providers.tsx';
import {
  FakeWebSocket,
  resetFakeWebSockets,
  fetchSpy,
  installFetchStub,
  jsonResponse,
  conversation,
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
  cleanup();
});

describe('connection banner in real route hierarchy', () => {
  it('shows a connecting banner on initial workspace render', async () => {
    installFetchStub((url) => {
      if (url === '/conversations?status=active&limit=20') {
        return jsonResponse({ conversations: [conversation('c-1', 'Test chat')], totalCount: 1 });
      }
      if (url === '/conversations/c-1/turns?limit=50') {
        return jsonResponse(EMPTY_HISTORY);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<AppProviders />);

    // The workspace route starts with transportStatus 'connecting', which is
    // not fully quiet → banner should render as a polite status.
    const banner = await screen.findByRole('status');
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent(/connecting/i);
  });

  it('hides the banner once the connection becomes fully operational', async () => {
    installFetchStub((url) => {
      if (url === '/conversations?status=active&limit=20') {
        return jsonResponse({ conversations: [conversation('c-1', 'Test chat')], totalCount: 1 });
      }
      if (url === '/conversations/c-1/turns?limit=50') {
        return jsonResponse(EMPTY_HISTORY);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<AppProviders />);

    // Wait for workspace to mount and show the initial connecting banner
    await screen.findByRole('status');

    // Open the WebSocket to move transport to 'live'
    const ws = latestSocket();
    act(() => {
      ws.simulateOpen();
    });

    // Once transport is live + sync idle + daemon healthy + session active,
    // the banner should disappear.
    await vi.waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.queryByRole('status')).toBeNull();
    });
  });

  it('shows an alert banner when connection degrades to disconnected', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    installFetchStub((url) => {
      if (url === '/conversations?status=active&limit=20') {
        return jsonResponse({ conversations: [conversation('c-1', 'Test chat')], totalCount: 1 });
      }
      if (url === '/conversations/c-1/turns?limit=50') {
        return jsonResponse(EMPTY_HISTORY);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<AppProviders />);
    await screen.findByRole('button', { name: /test chat/i });

    // Open and subscribe normally
    const ws = latestSocket();
    act(() => {
      ws.simulateOpen();
    });
    act(() => {
      ws.simulateMessage({ type: 'subscribed', conversationId: 'c-1', currentSeq: 0 });
    });

    // Banner should be hidden when connected
    await vi.waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.queryByRole('status')).toBeNull();
    });

    // Simulate abnormal close — triggers reconnect
    act(() => {
      ws.simulateClose(1006, 'abnormal');
    });

    // After close, the banner should show reconnecting status
    const banner = await screen.findByRole('status');
    expect(banner).toHaveTextContent(/reconnecting/i);

    vi.useRealTimers();
  });
});
