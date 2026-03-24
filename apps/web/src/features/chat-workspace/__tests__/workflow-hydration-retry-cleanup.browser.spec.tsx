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
    let turn1ArtifactAttempts = 0;

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
        turn1ArtifactAttempts++;
        // Always reject — the timer-driven retry is the only path to more
        // attempts after the effect-re-run attempt settles.
        return Promise.reject(new Error('transient network error'));
      }
      // Streaming turn artifact lookups — return empty (no artifacts yet)
      if (url.startsWith('/turns/') && url.endsWith('/artifacts')) {
        return Promise.resolve(jsonResponse({ artifacts: [] }));
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchSpy);

    render(<AppProviders />);
    await screen.findByRole('button', { name: /retry conv/i });
    const ws = openAndSubscribe('conv-1', 0);

    // Initial hydration failed — retry timer now scheduled.
    expect(turn1ArtifactAttempts).toBeGreaterThanOrEqual(1);

    // Trigger a same-conversation rerender by streaming a new turn.
    // This changes activeEntries, re-running the useArtifactHydration effect.
    // With the old unconditional-cleanup bug, this would clear the pending
    // retry timer; the fix scopes cleanup to conversation changes only.
    act(() => {
      ws.simulateMessage(streamFrame('conv-1', 1, 'turn-live', 'stream-started'));
      ws.simulateMessage(
        streamFrame('conv-1', 2, 'turn-live', 'text-delta', { text: 'live rerender' }),
      );
    });

    await screen.findByText('live rerender');

    // Capture count after the rerender (the effect re-run may have already
    // made an immediate re-attempt for turn-1).
    const countAfterRerender = turn1ArtifactAttempts;

    // Advance well past the 1 s retry delay.  If the timer survived the
    // same-conversation rerender it fires `setRetryNonce`, re-running the
    // effect and making at least one more artifact request.
    act(() => {
      vi.advanceTimersByTime(3_000);
    });

    // At least one timer-triggered retry must have fired.
    expect(turn1ArtifactAttempts).toBeGreaterThan(countAfterRerender);
  });
});
