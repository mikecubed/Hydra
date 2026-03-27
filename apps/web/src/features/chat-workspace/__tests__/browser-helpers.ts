/**
 * Shared test infrastructure for workspace live-stream browser specs.
 *
 * Contains the FakeWebSocket stand-in, fetch stub helpers, fixture
 * factories, and common DOM helpers used across scenario-focused spec files.
 */

import { act, screen } from '@testing-library/react';
import { expect, vi } from 'vitest';

// ─── JSON message narrowing helper ──────────────────────────────────────────

/** Safely parse a JSON string into a validated Record. */
function parseJsonMessage(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError(`Expected JSON object but got: ${typeof parsed}`);
  }
  return parsed as Record<string, unknown>;
}

// ─── FakeWebSocket ──────────────────────────────────────────────────────────

/**
 * Minimal controllable WebSocket stand-in.
 *
 * Every instance is captured in `fakeWebSockets` so tests can locate and
 * drive the socket created by `createStreamClient` inside the workspace
 * route. Mirrors the pattern in stream-client.test.ts.
 */
export class FakeWebSocket {
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
    return this.sent.map(parseJsonMessage);
  }
}

export let fakeWebSockets: FakeWebSocket[] = [];

export function resetFakeWebSockets(): void {
  fakeWebSockets = [];
}

export function latestSocket(): FakeWebSocket {
  const sock = fakeWebSockets.at(-1);
  if (!sock) throw new Error('No FakeWebSocket instances created');
  return sock;
}

// ─── Fetch helpers ──────────────────────────────────────────────────────────

export const fetchSpy = vi.fn<typeof fetch>();

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

export function jsonResponse(body: unknown, status = 200, statusText?: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function installFetchStub(
  handler: (url: string, init: RequestInit | undefined) => Response,
): void {
  fetchSpy.mockImplementation((input, init) => {
    const url = requestUrl(input);
    if (url === '/session/info') {
      return Promise.resolve(
        jsonResponse({
          operatorId: 'test-operator',
          state: 'active',
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          lastActivityAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        }),
      );
    }
    return Promise.resolve(handler(url, init));
  });
  vi.stubGlobal('fetch', fetchSpy);
}

// ─── Fixture factories ──────────────────────────────────────────────────────

export const EMPTY_HISTORY = { turns: [], totalCount: 0, hasMore: false };

export function conversation(
  id: string,
  title: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
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

export function submitResponse(
  conversationId: string,
  turnId: string,
  instruction: string,
): Record<string, unknown> {
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
export function streamFrame(
  conversationId: string,
  seq: number,
  turnId: string,
  kind: string,
  payload: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'stream-event',
    conversationId,
    event: { seq, turnId, kind, payload, timestamp: '2026-07-01T00:00:02.000Z' },
  };
}

// ─── Common DOM helpers ─────────────────────────────────────────────────────

/** All `<article>` elements in the DOM (one per transcript entry). */
export function transcriptArticles(): HTMLElement[] {
  return screen.queryAllByRole('article');
}

/**
 * Open the latest FakeWebSocket, verify the outbound subscribe frame, then
 * simulate the server's `subscribed` ack. Returns the socket for further use.
 */
export function openAndSubscribe(conversationId: string, currentSeq = 0): FakeWebSocket {
  const ws = latestSocket();
  act(() => {
    ws.simulateOpen();
  });

  const subFrames = ws.sentMessages.filter(
    (m) => m['type'] === 'subscribe' && m['conversationId'] === conversationId,
  );
  expect(subFrames).toHaveLength(1);

  act(() => {
    ws.simulateMessage({ type: 'subscribed', conversationId, currentSeq });
  });
  return ws;
}
