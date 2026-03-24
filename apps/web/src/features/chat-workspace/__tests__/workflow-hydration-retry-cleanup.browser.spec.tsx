/**
 * Browser workflow spec — hydration retry timer cleanup on conversation switch.
 *
 * Regression coverage for the fix that ensures:
 *   – switching away from a conversation always clears the scheduled retry timer
 *   – no stray retry fires after the user leaves the conversation that scheduled it
 *   – same-conversation rerenders do NOT cancel a pending retry timer
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, act } from '@testing-library/react';

import { AppProviders } from '../../../app/providers.tsx';
import {
  FakeWebSocket,
  resetFakeWebSockets,
  fetchSpy,
  jsonResponse,
  conversation,
  openAndSubscribe,
  streamFrame,
} from './browser-helpers.ts';

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  resetFakeWebSockets();
  fetchSpy.mockReset();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  cleanup();
});

// eslint-disable-next-line max-lines-per-function -- focused browser regression coverage
describe('hydration retry timer cleanup on conversation switch', () => {
  it('clears retry timer when switching to a different conversation', async () => {
    let artifactRequestCount = 0;

    fetchSpy.mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === '/conversations?status=active&limit=20') {
        return Promise.resolve(
          jsonResponse({
            conversations: [
              conversation('conv-1', 'First conv'),
              conversation('conv-2', 'Second conv'),
            ],
            totalCount: 2,
          }),
        );
      }
      if (url === '/conversations/conv-1/turns?limit=50') {
        return Promise.resolve(
          jsonResponse({
            turns: [
              {
                id: 'turn-1',
                conversationId: 'conv-1',
                position: 1,
                kind: 'agent',
                attribution: { type: 'agent', label: 'Claude' },
                response: 'Hello from conv-1',
                status: 'completed',
                createdAt: '2026-07-01T00:00:01.000Z',
                completedAt: '2026-07-01T00:00:02.000Z',
              },
            ],
            totalCount: 1,
            hasMore: false,
          }),
        );
      }
      if (url === '/conversations/conv-2/turns?limit=50') {
        return Promise.resolve(
          jsonResponse({
            turns: [],
            totalCount: 0,
            hasMore: false,
          }),
        );
      }
      if (url === '/conversations/conv-1/approvals' || url === '/conversations/conv-2/approvals') {
        return Promise.resolve(jsonResponse({ approvals: [] }));
      }
      if (url === '/turns/turn-1/artifacts') {
        artifactRequestCount++;
        // Always fail — this forces a retry timer to be scheduled
        return Promise.reject(new Error('transient network error'));
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchSpy);

    render(<AppProviders />);

    // Wait for the first conversation to load and attempt hydration
    await screen.findByRole('button', { name: /first conv/i });

    // The hydration failure should have scheduled a retry timer.
    // Now click on the second conversation to switch away.
    const secondConvButton = await screen.findByRole('button', { name: /second conv/i });
    act(() => {
      fireEvent.click(secondConvButton);
    });

    // Record artifact request count at switch time
    const countAtSwitch = artifactRequestCount;

    // Advance timers well past the 1s retry delay — if the timer leaked
    // it would fire and make another artifact request for conv-1
    act(() => {
      vi.advanceTimersByTime(3_000);
    });

    // No additional artifact hydration requests should have fired after switch
    expect(artifactRequestCount).toBe(countAtSwitch);
  });

  it('preserves the retry timer across same-conversation rerenders', async () => {
    let artifactRequestCount = 0;

    fetchSpy.mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === '/conversations?status=active&limit=20') {
        return Promise.resolve(
          jsonResponse({
            conversations: [conversation('conv-1', 'Retry conv')],
            totalCount: 1,
          }),
        );
      }
      if (url === '/conversations/conv-1/turns?limit=50') {
        return Promise.resolve(
          jsonResponse({
            turns: [
              {
                id: 'turn-1',
                conversationId: 'conv-1',
                position: 1,
                kind: 'agent',
                attribution: { type: 'agent', label: 'Claude' },
                response: 'Historical turn',
                status: 'completed',
                createdAt: '2026-07-01T00:00:01.000Z',
                completedAt: '2026-07-01T00:00:02.000Z',
              },
            ],
            totalCount: 1,
            hasMore: false,
          }),
        );
      }
      if (url === '/conversations/conv-1/approvals') {
        return Promise.resolve(jsonResponse({ approvals: [] }));
      }
      if (url === '/turns/turn-1/artifacts') {
        artifactRequestCount++;
        if (artifactRequestCount === 1) {
          return Promise.reject(new Error('transient network error'));
        }
        return Promise.resolve(
          jsonResponse({
            artifacts: [
              {
                id: 'art-1',
                turnId: 'turn-1',
                kind: 'file',
                label: 'artifact.txt',
                size: 10,
                createdAt: '2026-07-01T00:00:03.000Z',
              },
            ],
          }),
        );
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchSpy);

    render(<AppProviders />);
    await screen.findByRole('button', { name: /retry conv/i });
    const ws = openAndSubscribe('conv-1', 0);

    expect(artifactRequestCount).toBe(1);

    act(() => {
      ws.simulateMessage(streamFrame('conv-1', 1, 'turn-live', 'stream-started'));
      ws.simulateMessage(
        streamFrame('conv-1', 2, 'turn-live', 'text-delta', { text: 'live rerender' }),
      );
    });

    await screen.findByText('live rerender');

    act(() => {
      vi.advanceTimersByTime(1_100);
    });

    await screen.findByText('artifact.txt');
    expect(artifactRequestCount).toBe(2);
  });
});
