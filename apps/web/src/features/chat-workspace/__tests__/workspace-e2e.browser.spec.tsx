/**
 * End-to-end browser workflow tests for the live-stream workspace.
 *
 * Renders the full app via `<AppProviders />` (router + query client),
 * stubs both fetch (REST) and WebSocket (streaming) at the global level,
 * then drives user-visible workflows through the DOM.
 *
 * Covers Phase 2 integrated behaviour:
 *   – incremental text-delta rendering in the active transcript
 *   – conversation switching without mixing per-conversation stream state
 *   – create-mode submit with live streaming into the new conversation
 *   – continue-mode submit with streaming appended after existing history
 *   – reconnect / resume after an abnormal WebSocket close
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AppProviders } from '../../../app/providers.tsx';

// ─── FakeWebSocket ──────────────────────────────────────────────────────────

/**
 * Minimal controllable WebSocket stand-in.
 *
 * Every instance is captured in `fakeWebSockets` so tests can locate and
 * drive the socket created by `createStreamClient` inside the workspace
 * route. Mirrors the pattern in stream-client.test.ts.
 */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  url: string;
  readyState = FakeWebSocket.CONNECTING;

  onopen: ((ev: { type: string }) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: { type: string }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;

  readonly sent: string[] = [];

  constructor(url: string | URL) {
    this.url = typeof url === 'string' ? url : url.toString();
    fakeWebSockets.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(_code?: number, _reason?: string): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  // ─── Test helpers ─────────────────────────────────────────────────────

  simulateOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.({ type: 'open' });
  }

  simulateMessage(data: unknown): void {
    const raw = typeof data === 'string' ? data : JSON.stringify(data);
    this.onmessage?.({ data: raw });
  }

  simulateClose(code = 1000, reason = ''): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  get sentMessages(): Record<string, unknown>[] {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

let fakeWebSockets: FakeWebSocket[] = [];

function latestSocket(): FakeWebSocket {
  const sock = fakeWebSockets.at(-1);
  if (!sock) throw new Error('No FakeWebSocket instances created');
  return sock;
}

// ─── Fetch helpers (mirror existing browser specs) ──────────────────────────

const fetchSpy = vi.fn<typeof fetch>();

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function jsonResponse(body: unknown, status = 200, statusText?: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installFetchStub(handler: (url: string, init: RequestInit | undefined) => Response): void {
  fetchSpy.mockImplementation((input, init) => Promise.resolve(handler(requestUrl(input), init)));
  vi.stubGlobal('fetch', fetchSpy);
}

// ─── Fixture factories ──────────────────────────────────────────────────────

const EMPTY_HISTORY = { turns: [], totalCount: 0, hasMore: false };

function conversation(id: string, title: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title,
    status: 'active',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T12:00:00.000Z',
    turnCount: 0,
    pendingInstructionCount: 0,
    ...overrides,
  };
}

function submitResponse(conversationId: string, turnId: string, instruction: string) {
  return {
    turn: {
      id: turnId,
      conversationId,
      position: 1,
      kind: 'operator',
      attribution: { type: 'operator', label: 'Operator' },
      instruction,
      status: 'submitted',
      createdAt: '2026-07-01T00:00:01.000Z',
    },
    streamId: `stream-${turnId}`,
  };
}

/** Build a server→client WS frame for a stream event. */
function streamFrame(
  conversationId: string,
  seq: number,
  turnId: string,
  kind: string,
  payload: Record<string, unknown> = {},
) {
  return {
    type: 'stream-event',
    conversationId,
    event: { seq, turnId, kind, payload, timestamp: '2026-07-01T00:00:02.000Z' },
  };
}

// ─── Shared setup / teardown ────────────────────────────────────────────────

beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeWebSocket);
});

afterEach(() => {
  fakeWebSockets = [];
  fetchSpy.mockReset();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  cleanup();
});

// ─── Helpers for common WS handshake ────────────────────────────────────────

/**
 * Open the latest FakeWebSocket, verify the outbound subscribe frame, then
 * simulate the server's `subscribed` ack.  Returns the socket for further use.
 *
 * This proves the app actually sends the correct subscribe message before we
 * hand-feed the server acknowledgement.
 */
function openAndSubscribe(conversationId: string, currentSeq = 0): FakeWebSocket {
  const ws = latestSocket();
  act(() => {
    ws.simulateOpen();
  });

  // The client MUST have sent exactly one subscribe frame for this conversation
  const subFrames = ws.sentMessages.filter(
    (m) => m['type'] === 'subscribe' && m['conversationId'] === conversationId,
  );
  expect(subFrames.length).toBe(1);

  act(() => {
    ws.simulateMessage({ type: 'subscribed', conversationId, currentSeq });
  });
  return ws;
}

/** All `<article>` elements in the DOM (one per transcript entry). */
function transcriptArticles(): HTMLElement[] {
  return screen.queryAllByRole('article');
}

// ─── Tests ──────────────────────────────────────────────────────────────────

// eslint-disable-next-line max-lines-per-function
describe('workspace live-stream e2e workflows', () => {
  // ── 1. Incremental text deltas ──────────────────────────────────────────

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

    // Wait for the conversation sidebar to load
    await screen.findByRole('button', { name: /streaming demo/i });

    const ws = openAndSubscribe('conv-1');

    // stream-started → creates a new streaming entry
    act(() => {
      ws.simulateMessage(
        streamFrame('conv-1', 1, 'turn-s1', 'stream-started', {
          attribution: 'Claude',
        }),
      );
    });

    expect(await screen.findByText('streaming…')).toBeTruthy();

    // First text delta
    act(() => {
      ws.simulateMessage(
        streamFrame('conv-1', 2, 'turn-s1', 'text-delta', {
          text: 'Hello ',
        }),
      );
    });

    expect(await screen.findByText(/Hello/)).toBeTruthy();

    // Second text delta (appends)
    act(() => {
      ws.simulateMessage(
        streamFrame('conv-1', 3, 'turn-s1', 'text-delta', {
          text: 'world!',
        }),
      );
    });

    expect(await screen.findByText('Hello world!')).toBeTruthy();
    // Still streaming
    expect(screen.getByText('streaming…')).toBeTruthy();

    // stream-completed → entry transitions to completed
    act(() => {
      ws.simulateMessage(streamFrame('conv-1', 4, 'turn-s1', 'stream-completed', {}));
    });

    await vi.waitFor(() => {
      expect(screen.queryByText('streaming…')).toBeNull();
    });

    // Content persists after completion
    expect(screen.getByText('Hello world!')).toBeTruthy();
    expect(screen.getByText('completed')).toBeTruthy();

    // ── Transcript structure: single article with Claude attribution ──
    const articles = transcriptArticles();
    expect(articles.length).toBe(1);
    expect(screen.getByText('Claude')).toBeTruthy();
  });

  // ── 2. Conversation switching ───────────────────────────────────────────

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

    // Auto-selects first conversation
    await screen.findByRole('button', { name: /alpha/i });
    expect(screen.getByText('Active conversation: Alpha')).toBeTruthy();

    const ws = openAndSubscribe('conv-a');

    // Stream content into conv-a
    act(() => {
      ws.simulateMessage(streamFrame('conv-a', 1, 'turn-a1', 'stream-started'));
      ws.simulateMessage(
        streamFrame('conv-a', 2, 'turn-a1', 'text-delta', {
          text: 'Alpha response',
        }),
      );
      ws.simulateMessage(streamFrame('conv-a', 3, 'turn-a1', 'stream-completed'));
    });

    expect(await screen.findByText('Alpha response')).toBeTruthy();

    // Switch to conv-b
    fireEvent.click(screen.getByRole('button', { name: /bravo/i }));

    await vi.waitFor(() => {
      expect(screen.getByText('Active conversation: Bravo')).toBeTruthy();
    });

    // Conv-a content should not be visible
    expect(screen.queryByText('Alpha response')).toBeNull();

    // ── Subscription lifecycle: unsubscribe(old) → subscribe(new) ──
    const unsubA = ws.sentMessages.filter(
      (m) => m['type'] === 'unsubscribe' && m['conversationId'] === 'conv-a',
    );
    expect(unsubA.length).toBeGreaterThanOrEqual(1);

    const subB = ws.sentMessages.filter(
      (m) => m['type'] === 'subscribe' && m['conversationId'] === 'conv-b',
    );
    expect(subB.length).toBe(1);

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
        streamFrame('conv-b', 2, 'turn-b1', 'text-delta', {
          text: 'Bravo response',
        }),
      );
      ws.simulateMessage(streamFrame('conv-b', 3, 'turn-b1', 'stream-completed'));
    });

    expect(await screen.findByText('Bravo response')).toBeTruthy();
    expect(screen.queryByText('Alpha response')).toBeNull();

    // Switch back to conv-a — its content should be preserved
    fireEvent.click(screen.getByRole('button', { name: /alpha/i }));

    expect(await screen.findByText('Alpha response')).toBeTruthy();
    expect(screen.queryByText('Bravo response')).toBeNull();
  });

  // ── 3. Create-mode submit + streaming ───────────────────────────────────

  it('creates a conversation and streams the agent response', async () => {
    const createdConv = conversation('conv-new', 'New chat');
    let listCallCount = 0;

    installFetchStub((url, init) => {
      if (url === '/conversations?status=active&limit=20') {
        listCallCount++;
        if (listCallCount <= 1) {
          return jsonResponse({ conversations: [], totalCount: 0 });
        }
        // Post-create reload includes the new conversation
        return jsonResponse({ conversations: [createdConv], totalCount: 1 });
      }
      if (url === '/conversations' && init?.method === 'POST') {
        return jsonResponse(createdConv);
      }
      if (url === '/conversations/conv-new/turns' && init?.method === 'POST') {
        return jsonResponse(submitResponse('conv-new', 'turn-new', 'Build me a thing'));
      }
      if (url === '/conversations/conv-new/turns?limit=50') {
        // After creation the history includes the submitted operator instruction
        return jsonResponse({
          turns: [
            {
              id: 'turn-new',
              conversationId: 'conv-new',
              position: 1,
              kind: 'operator',
              attribution: { type: 'operator', label: 'Operator' },
              instruction: 'Build me a thing',
              status: 'submitted',
              createdAt: '2026-07-01T00:00:01.000Z',
            },
          ],
          totalCount: 1,
          hasMore: false,
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<AppProviders />);

    // Empty list → create mode. Composer is enabled.
    await vi.waitFor(() => {
      expect(screen.getByRole('textbox', { name: /instruction/i })).toBeTruthy();
    });

    // Type and submit
    fireEvent.change(screen.getByRole('textbox', { name: /instruction/i }), {
      target: { value: 'Build me a thing' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    // Wait for the conversation to appear in the sidebar
    await screen.findByRole('button', { name: /new chat/i });

    // Open WS and subscribe to the new conversation
    const ws = openAndSubscribe('conv-new');

    // Stream agent response into the new conversation
    act(() => {
      ws.simulateMessage(
        streamFrame('conv-new', 1, 'turn-agent-1', 'stream-started', {
          attribution: 'Claude',
        }),
      );
    });

    expect(await screen.findByText('streaming…')).toBeTruthy();

    act(() => {
      ws.simulateMessage(
        streamFrame('conv-new', 2, 'turn-agent-1', 'text-delta', {
          text: 'Here is your thing.',
        }),
      );
      ws.simulateMessage(streamFrame('conv-new', 3, 'turn-agent-1', 'stream-completed'));
    });

    expect(await screen.findByText('Here is your thing.')).toBeTruthy();
    await vi.waitFor(() => {
      expect(screen.queryByText('streaming…')).toBeNull();
    });

    // ── Transcript ownership: operator instruction + agent reply are distinct ──
    const articles = transcriptArticles();
    expect(articles.length).toBeGreaterThanOrEqual(2);

    // Operator instruction is a visible entry with correct attribution
    expect(screen.getByText('Build me a thing')).toBeTruthy();
    expect(screen.getByText('Operator')).toBeTruthy();

    // Agent reply carries Claude attribution
    expect(screen.getByText('Claude')).toBeTruthy();

    // Instruction and agent reply live in separate articles (not collapsed)
    const instructionArticle = screen.getByText('Build me a thing').closest('article');
    const agentArticle = screen.getByText('Here is your thing.').closest('article');
    expect(instructionArticle).toBeTruthy();
    expect(agentArticle).toBeTruthy();
    expect(instructionArticle).not.toBe(agentArticle);
  });

  // ── 4. Continue-mode submit + streaming ─────────────────────────────────

  it('appends streamed content after an existing transcript in continue mode', async () => {
    const existingTurn = {
      id: 'turn-1',
      conversationId: 'conv-1',
      position: 1,
      kind: 'operator',
      attribution: { type: 'operator', label: 'Operator' },
      instruction: 'Tell me about Hydra',
      response: 'Hydra is a multi-agent orchestrator.',
      status: 'completed',
      createdAt: '2026-07-01T00:00:00.000Z',
      completedAt: '2026-07-01T00:00:05.000Z',
    };

    const historyWithTurn = {
      turns: [existingTurn],
      totalCount: 1,
      hasMore: false,
    };

    let listCallCount = 0;

    installFetchStub((url, init) => {
      if (url === '/conversations?status=active&limit=20') {
        listCallCount++;
        return jsonResponse({
          conversations: [conversation('conv-1', 'Ongoing chat', { turnCount: 1 })],
          totalCount: 1,
        });
      }
      if (url === '/conversations/conv-1/turns?limit=50') {
        return jsonResponse(historyWithTurn);
      }
      if (url === '/conversations/conv-1/turns' && init?.method === 'POST') {
        return jsonResponse(submitResponse('conv-1', 'turn-2', 'Now add tests'));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<AppProviders />);

    // Existing history loads
    expect(await screen.findByText('Tell me about Hydra')).toBeTruthy();
    expect(screen.getByText('Hydra is a multi-agent orchestrator.')).toBeTruthy();

    const ws = openAndSubscribe('conv-1');

    // Submit a follow-up instruction
    fireEvent.change(screen.getByRole('textbox', { name: /instruction/i }), {
      target: { value: 'Now add tests' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    // Wait for submit to complete (list reloads)
    await vi.waitFor(() => {
      expect(listCallCount).toBeGreaterThanOrEqual(2);
    });

    // Stream agent response for the new turn
    act(() => {
      ws.simulateMessage(
        streamFrame('conv-1', 1, 'turn-agent-2', 'stream-started', {
          attribution: 'Codex',
        }),
      );
      ws.simulateMessage(
        streamFrame('conv-1', 2, 'turn-agent-2', 'text-delta', {
          text: 'Tests added for all modules.',
        }),
      );
      ws.simulateMessage(streamFrame('conv-1', 3, 'turn-agent-2', 'stream-completed'));
    });

    // New streamed content appears alongside existing history
    expect(await screen.findByText('Tests added for all modules.')).toBeTruthy();
    expect(screen.getByText('Hydra is a multi-agent orchestrator.')).toBeTruthy();
    expect(screen.getByText('Tell me about Hydra')).toBeTruthy();

    // ── Transcript ownership: history turn + streamed reply are distinct ──
    const articles = transcriptArticles();
    expect(articles.length).toBeGreaterThanOrEqual(2);

    // History turn carries Operator attribution and contains both instruction + response
    const historyArticle = screen.getByText('Tell me about Hydra').closest('article');
    expect(historyArticle).toBeTruthy();
    expect(historyArticle?.textContent).toContain('Hydra is a multi-agent orchestrator.');
    expect(historyArticle?.textContent).toContain('Operator');

    // Streamed agent turn carries Codex attribution
    const agentArticle = screen.getByText('Tests added for all modules.').closest('article');
    expect(agentArticle).toBeTruthy();
    expect(agentArticle?.textContent).toContain('Codex');

    // They must be separate articles (streamed text not collapsed into history entry)
    expect(historyArticle).not.toBe(agentArticle);
    expect(historyArticle?.textContent).not.toContain('Tests added for all modules.');
  });

  // ── 5. Reconnect / resume after abnormal close ─────────────────────────

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
        streamFrame('conv-1', 2, 'turn-r1', 'text-delta', {
          text: 'Before disconnect',
        }),
      );
    });

    expect(await screen.findByText('Before disconnect')).toBeTruthy();

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
    expect(subscribeMsgs.length).toBe(1);
    const sub = subscribeMsgs[0];
    expect(sub['conversationId']).toBe('conv-1');
    // Resume from seq 2 (last successfully acked event)
    expect(sub['lastAcknowledgedSeq']).toBe(2);

    // Server replays seq 2 (duplicate) then delivers seq 3 (new)
    act(() => {
      ws2.simulateMessage({ type: 'subscribed', conversationId: 'conv-1', currentSeq: 2 });
    });
    act(() => {
      // Replay — should be deduplicated by the reconciler
      ws2.simulateMessage(
        streamFrame('conv-1', 2, 'turn-r1', 'text-delta', {
          text: 'Before disconnect',
        }),
      );
      // New event
      ws2.simulateMessage(
        streamFrame('conv-1', 3, 'turn-r1', 'text-delta', {
          text: ' and after reconnect',
        }),
      );
      ws2.simulateMessage(streamFrame('conv-1', 4, 'turn-r1', 'stream-completed'));
    });

    // Content should be properly concatenated (no duplicate text)
    expect(await screen.findByText('Before disconnect and after reconnect')).toBeTruthy();
    await vi.waitFor(() => {
      expect(screen.queryByText('streaming…')).toBeNull();
    });

    // ── Dedup: single resumed article, no duplicate text ──
    const articles = transcriptArticles();
    expect(articles.length).toBe(1);

    // "Before disconnect" text appears in exactly one content paragraph
    const paras = articles[0].querySelectorAll('p');
    const matching = Array.from(paras).filter((p) => p.textContent.includes('Before disconnect'));
    expect(matching.length).toBe(1);
    expect(matching[0]?.textContent).toBe('Before disconnect and after reconnect');

    // Outbound: subscribe(resume) was the first message on ws2 with correct cursor
    expect(ws2.sentMessages[0]['type']).toBe('subscribe');
    expect(ws2.sentMessages[0]['lastAcknowledgedSeq']).toBe(2);
  });

  // ── 6. Stream-failed shows error in transcript ──────────────────────────

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
        streamFrame('conv-1', 2, 'turn-f1', 'text-delta', {
          text: 'Partial output…',
        }),
      );
      ws.simulateMessage(
        streamFrame('conv-1', 3, 'turn-f1', 'stream-failed', {
          reason: 'Agent crashed unexpectedly',
        }),
      );
    });

    expect(await screen.findByText('Partial output…')).toBeTruthy();
    expect(screen.getByText('Agent crashed unexpectedly')).toBeTruthy();
    expect(screen.getByText('failed')).toBeTruthy();
    expect(screen.queryByText('streaming…')).toBeNull();
  });
});
