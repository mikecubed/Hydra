/**
 * Browser workflow spec — refresh/reconnect recovery with authoritative merge.
 *
 * Phase 4 coverage for US4: verifies that after a page refresh or reconnect
 * during active streaming, the workspace transcript converges to the
 * authoritative REST state with no missing or duplicate visible entries.
 *
 * Covers:
 *   – full page refresh mid-stream: rehydrate from REST + resume live deltas for in-progress turn
 *   – stream-before-REST race: authoritative merge overwrites stream entries
 *   – sealed completed turns reject post-reconnect stream replays
 *   – banner visibility during reconnect recovery with stream continuity
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

// ─── Fixture helpers ────────────────────────────────────────────────────────

function agentTurn(
  id: string,
  conversationId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    conversationId,
    position: 1,
    kind: 'agent',
    attribution: { type: 'agent', label: 'Claude' },
    instruction: null,
    response: null,
    status: 'streaming',
    createdAt: '2026-07-01T00:00:01.000Z',
    completedAt: null,
    ...overrides,
  };
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

// eslint-disable-next-line max-lines-per-function
describe('workspace refresh/reconnect recovery workflows', () => {
  // eslint-disable-next-line max-lines-per-function -- multi-phase workflow test
  it('rehydrates from REST and resumes live streaming after full page refresh mid-turn', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    // Phase 1: initial render — turn is actively streaming
    let refreshed = false;
    installFetchStub((url) => {
      if (url === '/conversations?status=active&limit=20') {
        return jsonResponse({
          conversations: [conversation('conv-1', 'Live resume')],
          totalCount: 1,
        });
      }
      if (url === '/conversations/conv-1/turns?limit=50') {
        if (!refreshed) {
          return jsonResponse(EMPTY_HISTORY);
        }
        // After refresh: REST is slightly stale relative to the replay buffer.
        return jsonResponse({
          turns: [
            agentTurn('turn-a1', 'conv-1', {
              response: 'Rehydrated ',
              status: 'streaming',
            }),
          ],
          totalCount: 1,
          hasMore: false,
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<AppProviders />);
    await screen.findByRole('button', { name: /live resume/i });

    const ws1 = openAndSubscribe('conv-1', 0);

    // Deliver partial streaming content before the refresh
    act(() => {
      ws1.simulateMessage(
        streamFrame('conv-1', 1, 'turn-a1', 'stream-started', { attribution: 'Claude' }),
      );
      ws1.simulateMessage(
        streamFrame('conv-1', 2, 'turn-a1', 'text-delta', { text: 'Pre-refresh content' }),
      );
    });

    expect(await screen.findByText('Pre-refresh content')).toBeInTheDocument();
    expect(screen.getByText('streaming…')).toBeInTheDocument();

    // Phase 2: simulate full page refresh — unmount everything and re-render
    refreshed = true;
    cleanup();
    resetFakeWebSockets();

    render(<AppProviders />);
    await screen.findByRole('button', { name: /live resume/i });

    // REST rehydration: turn still streaming, but behind the replay buffer.
    await vi.waitFor(() => expect(screen.getByText(/^Rehydrated/)).toBeInTheDocument());

    // Turn should still show as streaming (not completed or missing)
    expect(screen.getByText('streaming…')).toBeInTheDocument();

    // Pre-refresh WS content replaced by REST authoritative snapshot
    expect(screen.queryByText('Pre-refresh content')).not.toBeInTheDocument();

    // Phase 3: WS reconnects and delivers only NEW deltas (server resumes correctly)
    const ws2 = latestSocket();
    act(() => {
      ws2.simulateOpen();
    });

    // Fresh state after refresh → no resume cursor
    const subMsgs = ws2.sentMessages.filter((m) => m['type'] === 'subscribe');
    expect(subMsgs).toHaveLength(1);

    // Gateway replay arrives before the subscribed ack on refresh/reconnect.
    act(() => {
      ws2.simulateMessage(streamFrame('conv-1', 4, 'turn-a1', 'text-delta', { text: 'partial: ' }));
      ws2.simulateMessage({ type: 'subscribed', conversationId: 'conv-1', currentSeq: 4 });
      ws2.simulateMessage(
        streamFrame('conv-1', 5, 'turn-a1', 'text-delta', { text: 'live delta one' }),
      );
      ws2.simulateMessage(
        streamFrame('conv-1', 6, 'turn-a1', 'text-delta', { text: ' and delta two' }),
      );
    });

    // Resumed deltas are visible and the pre-refresh text does not reappear.
    await vi.waitFor(() =>
      expect(screen.getByText(/^partial: live delta one and delta two$/)).toBeInTheDocument(),
    );
    expect(screen.queryByText('Pre-refresh content')).not.toBeInTheDocument();

    // REST-rehydrated base remains visible while replay + live deltas build on it.
    expect(screen.getByText(/^Rehydrated/)).toBeInTheDocument();

    // Complete the stream
    act(() => {
      ws2.simulateMessage(streamFrame('conv-1', 7, 'turn-a1', 'stream-completed'));
    });

    // Phase 4: final convergence assertions
    const articles = transcriptArticles();
    expect(articles).toHaveLength(1); // Single turn entry — no duplication

    const article = articles[0];

    const paragraphTexts = Array.from(
      article.querySelectorAll('p'),
      (paragraph) => paragraph.textContent,
    );
    expect(paragraphTexts).toEqual(['Rehydrated ', 'partial: live delta one and delta two']);

    // Turn transitioned to completed after stream-completed
    expect(screen.getByText('completed')).toBeInTheDocument();
    expect(screen.queryByText('streaming…')).not.toBeInTheDocument();
  });

  it('recovers streamed artifact notices for an active turn after refresh without replay', async () => {
    let refreshed = false;
    installFetchStub((url) => {
      if (url === '/conversations?status=active&limit=20') {
        return jsonResponse({
          conversations: [conversation('conv-1', 'Artifact refresh')],
          totalCount: 1,
        });
      }
      if (url === '/conversations/conv-1/turns?limit=50') {
        if (!refreshed) {
          return jsonResponse(EMPTY_HISTORY);
        }
        return jsonResponse({
          turns: [
            agentTurn('turn-a1', 'conv-1', {
              response: 'Still working…',
              status: 'streaming',
            }),
          ],
          totalCount: 1,
          hasMore: false,
        });
      }
      if (url === '/conversations/conv-1/approvals') {
        return jsonResponse({ approvals: [] });
      }
      if (url === '/turns/turn-a1/artifacts') {
        return jsonResponse({
          artifacts: [
            {
              id: 'art-1',
              turnId: 'turn-a1',
              kind: 'log',
              label: 'midstream.log',
              size: 42,
              createdAt: '2026-07-01T00:00:05.000Z',
            },
          ],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<AppProviders />);
    await screen.findByRole('button', { name: /artifact refresh/i });

    const ws1 = openAndSubscribe('conv-1', 0);
    act(() => {
      ws1.simulateMessage(
        streamFrame('conv-1', 1, 'turn-a1', 'stream-started', { attribution: 'Claude' }),
      );
      ws1.simulateMessage(
        streamFrame('conv-1', 2, 'turn-a1', 'artifact-notice', {
          artifactId: 'art-1',
          kind: 'log',
          label: 'midstream.log',
        }),
      );
    });

    expect(await screen.findByText('midstream.log')).toBeInTheDocument();

    refreshed = true;
    cleanup();
    resetFakeWebSockets();

    render(<AppProviders />);
    await screen.findByRole('button', { name: /artifact refresh/i });

    await vi.waitFor(() => expect(screen.getByText('Still working…')).toBeInTheDocument());
    await vi.waitFor(() => expect(screen.getByText('midstream.log')).toBeInTheDocument());
    expect(screen.getByText('streaming…')).toBeInTheDocument();
  });

  // eslint-disable-next-line max-lines-per-function -- multi-phase hydration race coverage
  it('reruns terminal artifact hydration when a live fetch resolves after stream completion', async () => {
    let resolveFirstArtifacts: ((response: Response) => void) | null = null;
    let artifactRequestCount = 0;

    fetchSpy.mockImplementation((input: string | URL | Request) => {
      const url = requestUrl(input);

      if (url === '/conversations?status=active&limit=20') {
        return Promise.resolve(
          jsonResponse({
            conversations: [conversation('conv-1', 'Terminal refresh')],
            totalCount: 1,
          }),
        );
      }
      if (url === '/conversations/conv-1/turns?limit=50') {
        return Promise.resolve(
          jsonResponse({
            turns: [
              agentTurn('turn-a1', 'conv-1', {
                response: 'Still working…',
                status: 'streaming',
              }),
            ],
            totalCount: 1,
            hasMore: false,
          }),
        );
      }
      if (url === '/conversations/conv-1/approvals') {
        return Promise.resolve(jsonResponse({ approvals: [] }));
      }
      if (url === '/turns/turn-a1/artifacts') {
        artifactRequestCount += 1;
        if (artifactRequestCount === 1) {
          return new Promise<Response>((resolve) => {
            resolveFirstArtifacts = resolve;
          });
        }
        return Promise.resolve(
          jsonResponse({
            artifacts: [
              {
                id: 'art-1',
                turnId: 'turn-a1',
                kind: 'log',
                label: 'midstream.log',
                size: 42,
                createdAt: '2026-07-01T00:00:05.000Z',
              },
              {
                id: 'art-2',
                turnId: 'turn-a1',
                kind: 'structured-data',
                label: 'final.json',
                size: 84,
                createdAt: '2026-07-01T00:00:06.000Z',
              },
            ],
          }),
        );
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchSpy);

    render(<AppProviders />);
    await screen.findByRole('button', { name: /terminal refresh/i });
    await vi.waitFor(() => expect(screen.getByText('Still working…')).toBeInTheDocument());
    await vi.waitFor(() => {
      expect(resolveFirstArtifacts).not.toBeNull();
    });

    const ws = latestSocket();
    act(() => {
      ws.simulateOpen();
      ws.simulateMessage({ type: 'subscribed', conversationId: 'conv-1', currentSeq: 0 });
      ws.simulateMessage(streamFrame('conv-1', 1, 'turn-a1', 'stream-completed'));
    });
    expect(await screen.findByText('completed')).toBeInTheDocument();

    act(() => {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- controlled by waitFor above
      resolveFirstArtifacts!(
        jsonResponse({
          artifacts: [
            {
              id: 'art-1',
              turnId: 'turn-a1',
              kind: 'log',
              label: 'midstream.log',
              size: 42,
              createdAt: '2026-07-01T00:00:05.000Z',
            },
          ],
        }),
      );
    });

    await vi.waitFor(() => expect(screen.getByText('midstream.log')).toBeInTheDocument());
    await vi.waitFor(() => expect(screen.getByText('final.json')).toBeInTheDocument());
    expect(artifactRequestCount).toBe(2);
  });

  it('rehydrates active-turn artifacts after switching away and back without replay', async () => {
    let conv1ArtifactRequests = 0;

    installFetchStub((url) => {
      if (url === '/conversations?status=active&limit=20') {
        return jsonResponse({
          conversations: [
            conversation('conv-1', 'Artifact switch'),
            conversation('conv-2', 'Other conversation'),
          ],
          totalCount: 2,
        });
      }
      if (url === '/conversations/conv-1/turns?limit=50') {
        return jsonResponse({
          turns: [
            agentTurn('turn-a1', 'conv-1', {
              response: 'Still working…',
              status: 'streaming',
            }),
          ],
          totalCount: 1,
          hasMore: false,
        });
      }
      if (url === '/conversations/conv-2/turns?limit=50') {
        return jsonResponse({
          turns: [
            agentTurn('turn-b1', 'conv-2', {
              response: 'Second conversation',
              status: 'streaming',
            }),
          ],
          totalCount: 1,
          hasMore: false,
        });
      }
      if (url === '/conversations/conv-1/approvals' || url === '/conversations/conv-2/approvals') {
        return jsonResponse({ approvals: [] });
      }
      if (url === '/turns/turn-a1/artifacts') {
        conv1ArtifactRequests += 1;
        return jsonResponse({
          artifacts:
            conv1ArtifactRequests === 1
              ? []
              : [
                  {
                    id: 'art-1',
                    turnId: 'turn-a1',
                    kind: 'log',
                    label: 'midstream.log',
                    size: 42,
                    createdAt: '2026-07-01T00:00:05.000Z',
                  },
                ],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<AppProviders />);
    const conv1Button = await screen.findByRole('button', { name: /artifact switch/i });
    const conv2Button = await screen.findByRole('button', { name: /other conversation/i });

    await vi.waitFor(() => expect(screen.getByText('Still working…')).toBeInTheDocument());
    await vi.waitFor(() => {
      expect(conv1ArtifactRequests).toBe(1);
    });
    expect(screen.queryByText('midstream.log')).not.toBeInTheDocument();

    fireEvent.click(conv2Button);
    await vi.waitFor(() => expect(screen.getByText('Second conversation')).toBeInTheDocument());

    fireEvent.click(conv1Button);
    await vi.waitFor(() => expect(screen.getByText('Still working…')).toBeInTheDocument());
    await vi.waitFor(() => expect(screen.getByText('midstream.log')).toBeInTheDocument());
    expect(conv1ArtifactRequests).toBe(2);
  });

  // Regression: quick switch away/back before hydration Promise settles must not
  // issue a duplicate listArtifactsForTurn request (GitHub PR #175 review thread).
  // eslint-disable-next-line max-lines-per-function -- deferred-resolve fetch stub spans many lines
  it('does not duplicate listArtifactsForTurn on quick switch away/back before hydration settles', async () => {
    let artifactRequestCount = 0;
    let resolveArtifact: ((r: Response) => void) | null = null;

    fetchSpy.mockImplementation((input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url === '/conversations?status=active&limit=20') {
        return Promise.resolve(
          jsonResponse({
            conversations: [
              conversation('conv-1', 'Hydration race'),
              conversation('conv-2', 'Other chat'),
            ],
            totalCount: 2,
          }),
        );
      }
      if (url === '/conversations/conv-1/turns?limit=50') {
        return Promise.resolve(
          jsonResponse({
            turns: [
              agentTurn('turn-a1', 'conv-1', {
                response: 'Working…',
                status: 'streaming',
              }),
            ],
            totalCount: 1,
            hasMore: false,
          }),
        );
      }
      if (url === '/conversations/conv-2/turns?limit=50') {
        return Promise.resolve(
          jsonResponse({
            turns: [
              agentTurn('turn-b1', 'conv-2', {
                response: 'Chat B',
                status: 'streaming',
              }),
            ],
            totalCount: 1,
            hasMore: false,
          }),
        );
      }
      if (url === '/conversations/conv-1/approvals' || url === '/conversations/conv-2/approvals') {
        return Promise.resolve(jsonResponse({ approvals: [] }));
      }
      if (url === '/turns/turn-a1/artifacts') {
        artifactRequestCount += 1;
        return new Promise<Response>((resolve) => {
          resolveArtifact = resolve;
        });
      }
      if (url === '/turns/turn-b1/artifacts') {
        return Promise.resolve(jsonResponse({ artifacts: [] }));
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchSpy);

    render(<AppProviders />);
    const conv1Button = await screen.findByRole('button', { name: /hydration race/i });
    const conv2Button = await screen.findByRole('button', { name: /other chat/i });

    // Wait for conv-1 history to load and artifact hydration to start (unsettled)
    await vi.waitFor(() => expect(screen.getByText('Working…')).toBeInTheDocument());
    await vi.waitFor(() => {
      expect(artifactRequestCount).toBe(1);
    });
    expect(resolveArtifact).not.toBeNull();

    // Switch away to conv-2 while hydration is in-flight
    fireEvent.click(conv2Button);
    await vi.waitFor(() => expect(screen.getByText('Chat B')).toBeInTheDocument());

    // Switch back to conv-1 before the first hydration settles
    fireEvent.click(conv1Button);
    await vi.waitFor(() => expect(screen.getByText('Working…')).toBeInTheDocument());

    // The quick switch-back must NOT issue a second artifact request
    expect(artifactRequestCount).toBe(1);

    // Resolve the original in-flight hydration
    act(() => {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by expect above
      resolveArtifact!(
        jsonResponse({
          artifacts: [
            {
              id: 'art-race',
              turnId: 'turn-a1',
              kind: 'log',
              label: 'race-resolved.log',
              size: 10,
              createdAt: '2026-07-01T00:00:05.000Z',
            },
          ],
        }),
      );
    });

    // Artifact should appear — the resolved Promise wrote to current ref structures
    await vi.waitFor(() => expect(screen.getByText('race-resolved.log')).toBeInTheDocument());

    // Still only 1 artifact request total — no duplicate
    expect(artifactRequestCount).toBe(1);
  });

  it('overwrites stream-populated entries when REST authoritative merge arrives later', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    // Delay REST history so stream events arrive first
    let resolveHistory: ((r: Response) => void) | null = null;

    fetchSpy.mockImplementation((input: string | URL | Request) => {
      let url: string;
      if (typeof input === 'string') {
        url = input;
      } else if (input instanceof URL) {
        url = input.toString();
      } else {
        url = input.url;
      }
      if (url === '/conversations?status=active&limit=20') {
        return Promise.resolve(
          jsonResponse({
            conversations: [conversation('conv-1', 'Race test')],
            totalCount: 1,
          }),
        );
      }
      if (url === '/conversations/conv-1/turns?limit=50') {
        return new Promise<Response>((resolve) => {
          resolveHistory = resolve;
        });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchSpy);

    render(<AppProviders />);
    await screen.findByRole('button', { name: /race test/i });

    // WS connects — stream events arrive before REST history resolves
    const ws = latestSocket();
    act(() => {
      ws.simulateOpen();
    });

    const subMsgs = ws.sentMessages.filter((m) => m['type'] === 'subscribe');
    expect(subMsgs).toHaveLength(1);
    act(() => {
      ws.simulateMessage({ type: 'subscribed', conversationId: 'conv-1', currentSeq: 0 });
    });

    // Stream events populate entries before REST loads
    act(() => {
      ws.simulateMessage(
        streamFrame('conv-1', 1, 'turn-a1', 'stream-started', { attribution: 'Claude' }),
      );
      ws.simulateMessage(
        streamFrame('conv-1', 2, 'turn-a1', 'text-delta', { text: 'Stream-only partial' }),
      );
      ws.simulateMessage(streamFrame('conv-1', 3, 'turn-a1', 'stream-completed'));
    });

    // Stream content visible temporarily
    expect(await screen.findByText('Stream-only partial')).toBeInTheDocument();

    // Now resolve REST history with authoritative completed turn
    expect(resolveHistory).not.toBeNull();
    act(() => {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- controlled test: resolveHistory is set above
      resolveHistory!(
        jsonResponse({
          turns: [
            agentTurn('turn-a1', 'conv-1', {
              response: 'REST authoritative response.',
              status: 'completed',
              completedAt: '2026-07-01T00:00:05.000Z',
            }),
          ],
          totalCount: 1,
          hasMore: false,
        }),
      );
    });

    // After merge, REST authoritative content replaces stream content
    await vi.waitFor(() => {
      expect(screen.getByText('REST authoritative response.')).toBeInTheDocument();
    });

    // Stream partial content no longer visible
    expect(screen.queryByText('Stream-only partial')).not.toBeInTheDocument();

    // Single article — merge deduplicates by turnId
    expect(transcriptArticles()).toHaveLength(1);
    expect(screen.getByText('completed')).toBeInTheDocument();
  });

  it('does not duplicate replayed text when REST is already ahead for a streaming turn', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    let refreshed = false;
    installFetchStub((url) => {
      if (url === '/conversations?status=active&limit=20') {
        return jsonResponse({
          conversations: [conversation('conv-1', 'REST ahead')],
          totalCount: 1,
        });
      }
      if (url === '/conversations/conv-1/turns?limit=50') {
        if (!refreshed) {
          return jsonResponse(EMPTY_HISTORY);
        }
        return jsonResponse({
          turns: [
            agentTurn('turn-a1', 'conv-1', {
              response: 'Hello',
              status: 'streaming',
            }),
          ],
          totalCount: 1,
          hasMore: false,
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<AppProviders />);
    await screen.findByRole('button', { name: /rest ahead/i });

    const ws1 = openAndSubscribe('conv-1', 0);
    act(() => {
      ws1.simulateMessage(
        streamFrame('conv-1', 1, 'turn-a1', 'stream-started', { attribution: 'Claude' }),
      );
      ws1.simulateMessage(streamFrame('conv-1', 2, 'turn-a1', 'text-delta', { text: 'Hello' }));
    });
    expect(await screen.findByText('Hello')).toBeInTheDocument();

    refreshed = true;
    cleanup();
    resetFakeWebSockets();

    render(<AppProviders />);
    await screen.findByRole('button', { name: /rest ahead/i });
    await vi.waitFor(() => expect(screen.getByText('Hello')).toBeInTheDocument());

    const ws2 = latestSocket();
    act(() => {
      ws2.simulateOpen();
      ws2.simulateMessage(streamFrame('conv-1', 3, 'turn-a1', 'text-delta', { text: 'Hello' }));
      ws2.simulateMessage({ type: 'subscribed', conversationId: 'conv-1', currentSeq: 3 });
      ws2.simulateMessage(streamFrame('conv-1', 4, 'turn-a1', 'text-delta', { text: ' world' }));
      ws2.simulateMessage(streamFrame('conv-1', 5, 'turn-a1', 'stream-completed'));
    });

    await vi.waitFor(() => expect(screen.getByText('completed')).toBeInTheDocument());

    const article = transcriptArticles()[0];
    const paragraphTexts = Array.from(
      article.querySelectorAll('p'),
      (paragraph) => paragraph.textContent,
    );
    expect(paragraphTexts).toEqual(['Hello', ' world']);
  });

  it('seals completed turns after REST merge, rejecting subsequent stream replays', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    installFetchStub((url) => {
      if (url === '/conversations?status=active&limit=20') {
        return jsonResponse({
          conversations: [conversation('conv-1', 'Seal test')],
          totalCount: 1,
        });
      }
      if (url === '/conversations/conv-1/turns?limit=50') {
        return jsonResponse({
          turns: [
            agentTurn('turn-a1', 'conv-1', {
              position: 1,
              response: 'First turn — complete.',
              status: 'completed',
              completedAt: '2026-07-01T00:00:03.000Z',
            }),
            agentTurn('turn-a2', 'conv-1', {
              position: 2,
              status: 'streaming',
            }),
          ],
          totalCount: 2,
          hasMore: false,
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<AppProviders />);
    await screen.findByRole('button', { name: /seal test/i });

    // Wait for REST history to load (turn-a1 completed, turn-a2 streaming)
    await vi.waitFor(() => {
      expect(screen.getByText('First turn — complete.')).toBeInTheDocument();
    });

    const ws = openAndSubscribe('conv-1', 5);

    // Replay event for the COMPLETED turn — must be rejected (sealed)
    act(() => {
      ws.simulateMessage(
        streamFrame('conv-1', 3, 'turn-a1', 'text-delta', { text: ' REPLAY INJECTION' }),
      );
    });

    // Deliver live content for the in-progress turn
    act(() => {
      ws.simulateMessage(
        streamFrame('conv-1', 6, 'turn-a2', 'text-delta', { text: 'Live streaming content' }),
      );
      ws.simulateMessage(streamFrame('conv-1', 7, 'turn-a2', 'stream-completed'));
    });

    await vi.waitFor(() => {
      expect(screen.getByText('Live streaming content')).toBeInTheDocument();
    });

    const articles = transcriptArticles();
    expect(articles).toHaveLength(2);

    // Completed turn was NOT mutated by the replay
    expect(within(articles[0]).getByText('First turn — complete.')).toBeInTheDocument();
    expect(within(articles[0]).queryByText(/REPLAY INJECTION/)).not.toBeInTheDocument();

    // In-progress turn received live updates normally
    expect(within(articles[1]).getByText('Live streaming content')).toBeInTheDocument();
  });

  it('shows reconnecting banner during recovery and hides after convergence', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    installFetchStub((url) => {
      if (url === '/conversations?status=active&limit=20') {
        return jsonResponse({
          conversations: [conversation('conv-1', 'Banner recovery')],
          totalCount: 1,
        });
      }
      if (url === '/conversations/conv-1/turns?limit=50') {
        return jsonResponse(EMPTY_HISTORY);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<AppProviders />);
    await screen.findByRole('button', { name: /banner recovery/i });

    // Establish connection — banner should hide
    const ws1 = openAndSubscribe('conv-1', 0);
    await vi.waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.queryByRole('status')).toBeNull();
    });

    // Begin streaming
    act(() => {
      ws1.simulateMessage(
        streamFrame('conv-1', 1, 'turn-b1', 'stream-started', { attribution: 'Claude' }),
      );
      ws1.simulateMessage(
        streamFrame('conv-1', 2, 'turn-b1', 'text-delta', { text: 'Working on it…' }),
      );
    });
    expect(await screen.findByText('Working on it…')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/instruction/i), {
      target: { value: 'Resume work after reconnect' },
    });
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();

    // Disconnect during active streaming
    act(() => {
      ws1.simulateClose(1006, 'abnormal');
    });

    // Banner must show reconnecting status
    const banner = await screen.findByRole('status');
    expect(banner).toHaveTextContent(/reconnecting/i);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();

    // Advance past reconnect delay
    act(() => {
      vi.advanceTimersByTime(1_500);
    });

    // Reconnect on a new socket
    const ws2 = latestSocket();
    expect(ws2).not.toBe(ws1);
    act(() => {
      ws2.simulateOpen();
    });

    // Subscribe with resume cursor from pre-disconnect progress
    const subMsgs = ws2.sentMessages.filter((m) => m['type'] === 'subscribe');
    expect(subMsgs).toHaveLength(1);
    expect(subMsgs[0]['lastAcknowledgedSeq']).toBe(2);

    act(() => {
      ws2.simulateMessage({ type: 'subscribed', conversationId: 'conv-1', currentSeq: 2 });
    });

    // Banner should hide after successful reconnect + subscribe
    await vi.waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.queryByRole('status')).toBeNull();
    });
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();

    // Pre-disconnect content survived reconnect
    expect(screen.getByText('Working on it…')).toBeInTheDocument();

    // Continue streaming on the reconnected socket — no gap or duplication
    act(() => {
      ws2.simulateMessage(streamFrame('conv-1', 3, 'turn-b1', 'text-delta', { text: ' Done!' }));
      ws2.simulateMessage(streamFrame('conv-1', 4, 'turn-b1', 'stream-completed'));
    });

    expect(await screen.findByText('Working on it… Done!')).toBeInTheDocument();
    expect(screen.getByText('completed')).toBeInTheDocument();
    expect(transcriptArticles()).toHaveLength(1);
  });

  it('clears stale degraded submit gating when reconnect opens after offline recovery', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    installFetchStub((url) => {
      if (url === '/conversations?status=active&limit=20') {
        return jsonResponse({
          conversations: [conversation('conv-1', 'Offline recovery')],
          totalCount: 1,
        });
      }
      if (url === '/conversations/conv-1/turns?limit=50') {
        return jsonResponse(EMPTY_HISTORY);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<AppProviders />);
    await screen.findByRole('button', { name: /offline recovery/i });

    const ws1 = openAndSubscribe('conv-1', 0);
    fireEvent.change(screen.getByLabelText(/instruction/i), {
      target: { value: 'Resume after offline recovery' },
    });
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();

    act(() => {
      ws1.simulateMessage({ type: 'daemon-unavailable' });
      ws1.simulateClose(1006, 'offline');
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(/reconnecting/i);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();

    act(() => {
      vi.advanceTimersByTime(1_500);
    });

    const ws2 = latestSocket();
    expect(ws2).not.toBe(ws1);
    act(() => {
      ws2.simulateOpen();
    });
    act(() => {
      ws2.simulateMessage({ type: 'daemon-restored' });
      ws2.simulateMessage({ type: 'session-active', expiresAt: '2026-08-01T00:00:00.000Z' });
      ws2.simulateMessage({ type: 'subscribed', conversationId: 'conv-1', currentSeq: 0 });
    });

    await vi.waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.queryByRole('status')).toBeNull();
      expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
    });
  });
});
