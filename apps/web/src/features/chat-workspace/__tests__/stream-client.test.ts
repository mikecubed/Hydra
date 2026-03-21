/**
 * Tests for the browser-side WebSocket stream adapter.
 *
 * Verifies connect, subscribe, unsubscribe, ack lifecycle,
 * inbound message parsing/dispatch, and error/close hooks.
 *
 * Uses a fake WebSocket class injected via options for isolation.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  createStreamClient,
  type StreamClientOptions,
  type StreamClientCallbacks,
} from '../api/stream-client.ts';

import type { GatewayErrorBody } from '../../../shared/gateway-errors.ts';

// ─── Lightweight event shims for Node.js (no DOM globals) ───────────────────

/** Minimal Event-like object for Node.js test environment. */
interface FakeEvent {
  readonly type: string;
}

/** Minimal MessageEvent-like object for Node.js test environment. */
interface FakeMessageEvent extends FakeEvent {
  readonly data: string;
}

/** Minimal CloseEvent-like object for Node.js test environment. */
interface FakeCloseEvent extends FakeEvent {
  readonly code: number;
  readonly reason: string;
}

function fakeEvent(type: string): FakeEvent {
  return { type };
}

function fakeMessageEvent(data: string): FakeMessageEvent {
  return { type: 'message', data };
}

function fakeCloseEvent(code: number, reason: string): FakeCloseEvent {
  return { type: 'close', code, reason };
}

// ─── Fake WebSocket ─────────────────────────────────────────────────────────

/** Minimal WebSocket-like interface for testing. */
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
  readyState: number = FakeWebSocket.CONNECTING;

  onopen: ((ev: FakeEvent) => void) | null = null;
  onmessage: ((ev: FakeMessageEvent) => void) | null = null;
  onerror: ((ev: FakeEvent) => void) | null = null;
  onclose: ((ev: FakeCloseEvent) => void) | null = null;

  readonly sent: string[] = [];
  private _closeCalled = false;

  constructor(url: string | URL) {
    this.url = typeof url === 'string' ? url : url.toString();
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this._closeCalled = true;
    this.readyState = FakeWebSocket.CLOSED;
    if (this.onclose) {
      this.onclose(fakeCloseEvent(code ?? 1000, reason ?? ''));
    }
  }

  get closeCalled(): boolean {
    return this._closeCalled;
  }

  // ─── Test helpers ─────────────────────────────────────────────────────

  /** Simulate the socket opening. */
  simulateOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    if (this.onopen) this.onopen(fakeEvent('open'));
  }

  /** Simulate receiving a server message. */
  simulateMessage(data: unknown): void {
    const raw = typeof data === 'string' ? data : JSON.stringify(data);
    if (this.onmessage) {
      this.onmessage(fakeMessageEvent(raw));
    }
  }

  /** Simulate an error event. */
  simulateError(): void {
    if (this.onerror) this.onerror(fakeEvent('error'));
  }

  /** Simulate a close event. */
  simulateClose(code = 1000, reason = ''): void {
    this.readyState = FakeWebSocket.CLOSED;
    if (this.onclose) {
      this.onclose(fakeCloseEvent(code, reason));
    }
  }

  /** Parse sent messages as JSON. */
  get sentMessages(): unknown[] {
    return this.sent.map((s) => JSON.parse(s) as unknown);
  }
}

// ─── Test helpers ───────────────────────────────────────────────────────────

let lastFakeSocket: FakeWebSocket | null = null;

/** WebSocket constructor that captures the created instance. */
function fakeWebSocketCtor(url: string | URL): FakeWebSocket {
  const sock = new FakeWebSocket(url);
  lastFakeSocket = sock;
  return sock;
}

function defaultOptions(overrides: Partial<StreamClientOptions> = {}): StreamClientOptions {
  return {
    baseUrl: 'wss://gw.test/ws',
    createWebSocket: fakeWebSocketCtor as StreamClientOptions['createWebSocket'],
    ...overrides,
  };
}

function noopCallbacks(overrides: Partial<StreamClientCallbacks> = {}): StreamClientCallbacks {
  return { ...overrides };
}

function streamEventPayload(overrides: Record<string, unknown> = {}) {
  return {
    type: 'stream-event',
    conversationId: 'conv-1',
    event: {
      seq: 1,
      turnId: 'turn-1',
      kind: 'text-delta',
      payload: { text: 'hello' },
      timestamp: '2026-06-01T12:00:00.000Z',
    },
    ...overrides,
  };
}

function subscribedPayload(overrides: Record<string, unknown> = {}) {
  return {
    type: 'subscribed',
    conversationId: 'conv-1',
    currentSeq: 5,
    ...overrides,
  };
}

function errorPayload(overrides: Record<string, unknown> = {}) {
  return {
    type: 'error',
    ok: false,
    code: 'RATE_LIMITED',
    category: 'rate-limit',
    message: 'Slow down',
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('StreamClient', () => {
  beforeEach(() => {
    lastFakeSocket = null;
  });

  // ─── Construction & connect ─────────────────────────────────────────

  describe('connect()', () => {
    it('creates a WebSocket with the configured baseUrl', () => {
      const client = createStreamClient(defaultOptions());
      client.connect(noopCallbacks());
      assert.ok(lastFakeSocket, 'should have created a WebSocket');
      assert.equal(lastFakeSocket.url, 'wss://gw.test/ws');
    });

    it('fires onOpen callback when socket opens', () => {
      const calls: string[] = [];
      const client = createStreamClient(defaultOptions());
      client.connect(noopCallbacks({ onOpen: () => calls.push('open') }));
      assert.ok(lastFakeSocket);
      lastFakeSocket.simulateOpen();
      assert.deepStrictEqual(calls, ['open']);
    });

    it('throws if connect() is called while already connected', () => {
      const client = createStreamClient(defaultOptions());
      client.connect(noopCallbacks());
      assert.ok(lastFakeSocket);
      lastFakeSocket.simulateOpen();
      assert.throws(
        () => {
          client.connect(noopCallbacks());
        },
        (err: Error) => err.message.includes('already'),
      );
    });

    it('allows reconnecting after close', () => {
      const client = createStreamClient(defaultOptions());
      client.connect(noopCallbacks());
      assert.ok(lastFakeSocket);
      lastFakeSocket.simulateOpen();
      client.close();
      // Should not throw
      lastFakeSocket = null;
      client.connect(noopCallbacks());
      assert.ok(lastFakeSocket, 'new socket should be created');
    });
  });

  // ─── subscribe ──────────────────────────────────────────────────────

  describe('subscribe()', () => {
    it('sends a subscribe message with conversationId', () => {
      const client = createStreamClient(defaultOptions());
      client.connect(noopCallbacks());
      assert.ok(lastFakeSocket);
      lastFakeSocket.simulateOpen();

      client.subscribe('conv-42');

      assert.equal(lastFakeSocket.sentMessages.length, 1);
      assert.deepStrictEqual(lastFakeSocket.sentMessages[0], {
        type: 'subscribe',
        conversationId: 'conv-42',
      });
    });

    it('sends subscribe with lastAcknowledgedSeq for resume', () => {
      const client = createStreamClient(defaultOptions());
      client.connect(noopCallbacks());
      assert.ok(lastFakeSocket);
      lastFakeSocket.simulateOpen();

      client.subscribe('conv-42', 10);

      assert.deepStrictEqual(lastFakeSocket.sentMessages[0], {
        type: 'subscribe',
        conversationId: 'conv-42',
        lastAcknowledgedSeq: 10,
      });
    });

    it('throws if called before connect()', () => {
      const client = createStreamClient(defaultOptions());
      assert.throws(
        () => {
          client.subscribe('conv-1');
        },
        (err: Error) => err.message.includes('not connected'),
      );
    });
  });

  // ─── unsubscribe ────────────────────────────────────────────────────

  describe('unsubscribe()', () => {
    it('sends an unsubscribe message', () => {
      const client = createStreamClient(defaultOptions());
      client.connect(noopCallbacks());
      assert.ok(lastFakeSocket);
      lastFakeSocket.simulateOpen();

      client.unsubscribe('conv-42');

      assert.deepStrictEqual(lastFakeSocket.sentMessages[0], {
        type: 'unsubscribe',
        conversationId: 'conv-42',
      });
    });

    it('throws if called before connect()', () => {
      const client = createStreamClient(defaultOptions());
      assert.throws(
        () => {
          client.unsubscribe('conv-1');
        },
        (err: Error) => err.message.includes('not connected'),
      );
    });
  });

  // ─── ack ────────────────────────────────────────────────────────────

  describe('ack()', () => {
    it('sends an ack message with conversationId and seq', () => {
      const client = createStreamClient(defaultOptions());
      client.connect(noopCallbacks());
      assert.ok(lastFakeSocket);
      lastFakeSocket.simulateOpen();

      client.ack('conv-42', 7);

      assert.deepStrictEqual(lastFakeSocket.sentMessages[0], {
        type: 'ack',
        conversationId: 'conv-42',
        seq: 7,
      });
    });

    it('throws if called before connect()', () => {
      const client = createStreamClient(defaultOptions());
      assert.throws(
        () => {
          client.ack('conv-1', 0);
        },
        (err: Error) => err.message.includes('not connected'),
      );
    });
  });

  // ─── close ──────────────────────────────────────────────────────────

  describe('close()', () => {
    it('closes the underlying WebSocket', () => {
      const client = createStreamClient(defaultOptions());
      client.connect(noopCallbacks());
      assert.ok(lastFakeSocket);
      lastFakeSocket.simulateOpen();

      client.close();

      assert.ok(lastFakeSocket.closeCalled);
    });

    it('is safe to call when not connected', () => {
      const client = createStreamClient(defaultOptions());
      // Should not throw
      client.close();
    });
  });

  // ─── readyState ─────────────────────────────────────────────────────

  describe('readyState', () => {
    it('returns CLOSED when not connected', () => {
      const client = createStreamClient(defaultOptions());
      assert.equal(client.readyState, FakeWebSocket.CLOSED);
    });

    it('returns CONNECTING after connect() before open', () => {
      const client = createStreamClient(defaultOptions());
      client.connect(noopCallbacks());
      assert.equal(client.readyState, FakeWebSocket.CONNECTING);
    });

    it('returns OPEN after the socket opens', () => {
      const client = createStreamClient(defaultOptions());
      client.connect(noopCallbacks());
      assert.ok(lastFakeSocket);
      lastFakeSocket.simulateOpen();
      assert.equal(client.readyState, FakeWebSocket.OPEN);
    });

    it('returns CLOSED after close()', () => {
      const client = createStreamClient(defaultOptions());
      client.connect(noopCallbacks());
      assert.ok(lastFakeSocket);
      lastFakeSocket.simulateOpen();
      client.close();
      assert.equal(client.readyState, FakeWebSocket.CLOSED);
    });
  });

  // ─── Inbound message parsing ────────────────────────────────────────

  describe('inbound messages', () => {
    it('dispatches stream-event to onStreamEvent', () => {
      const events: Array<{ conversationId: string; event: unknown }> = [];
      const client = createStreamClient(defaultOptions());
      client.connect(
        noopCallbacks({
          onStreamEvent: (conversationId, event) => events.push({ conversationId, event }),
        }),
      );
      assert.ok(lastFakeSocket);
      lastFakeSocket.simulateOpen();

      lastFakeSocket.simulateMessage(streamEventPayload());

      assert.equal(events.length, 1);
      assert.equal(events[0].conversationId, 'conv-1');
      assert.equal((events[0].event as { seq: number }).seq, 1);
    });

    it('dispatches subscribed to onSubscribed', () => {
      const calls: Array<{ conversationId: string; currentSeq: number }> = [];
      const client = createStreamClient(defaultOptions());
      client.connect(
        noopCallbacks({
          onSubscribed: (conversationId, currentSeq) => calls.push({ conversationId, currentSeq }),
        }),
      );
      assert.ok(lastFakeSocket);
      lastFakeSocket.simulateOpen();

      lastFakeSocket.simulateMessage(subscribedPayload());

      assert.equal(calls.length, 1);
      assert.equal(calls[0].conversationId, 'conv-1');
      assert.equal(calls[0].currentSeq, 5);
    });

    it('dispatches unsubscribed to onUnsubscribed', () => {
      const ids: string[] = [];
      const client = createStreamClient(defaultOptions());
      client.connect(noopCallbacks({ onUnsubscribed: (id) => ids.push(id) }));
      assert.ok(lastFakeSocket);
      lastFakeSocket.simulateOpen();

      lastFakeSocket.simulateMessage({ type: 'unsubscribed', conversationId: 'conv-3' });

      assert.deepStrictEqual(ids, ['conv-3']);
    });

    it('dispatches session-terminated to onSessionTerminated', () => {
      const calls: Array<{ state: string; reason?: string }> = [];
      const client = createStreamClient(defaultOptions());
      client.connect(
        noopCallbacks({
          onSessionTerminated: (state, reason) => calls.push({ state, reason }),
        }),
      );
      assert.ok(lastFakeSocket);
      lastFakeSocket.simulateOpen();

      lastFakeSocket.simulateMessage({
        type: 'session-terminated',
        state: 'expired',
        reason: 'Idle timeout',
      });

      assert.equal(calls.length, 1);
      assert.equal(calls[0].state, 'expired');
      assert.equal(calls[0].reason, 'Idle timeout');
    });

    it('dispatches session-expiring-soon to onSessionExpiringSoon', () => {
      const dates: string[] = [];
      const client = createStreamClient(defaultOptions());
      client.connect(
        noopCallbacks({ onSessionExpiringSoon: (expiresAt) => dates.push(expiresAt) }),
      );
      assert.ok(lastFakeSocket);
      lastFakeSocket.simulateOpen();

      lastFakeSocket.simulateMessage({
        type: 'session-expiring-soon',
        expiresAt: '2026-06-01T13:00:00.000Z',
      });

      assert.deepStrictEqual(dates, ['2026-06-01T13:00:00.000Z']);
    });

    it('dispatches daemon-unavailable to onDaemonUnavailable', () => {
      const calls: string[] = [];
      const client = createStreamClient(defaultOptions());
      client.connect(noopCallbacks({ onDaemonUnavailable: () => calls.push('fired') }));
      assert.ok(lastFakeSocket);
      lastFakeSocket.simulateOpen();

      lastFakeSocket.simulateMessage({ type: 'daemon-unavailable' });

      assert.deepStrictEqual(calls, ['fired']);
    });

    it('dispatches daemon-restored to onDaemonRestored', () => {
      const calls: string[] = [];
      const client = createStreamClient(defaultOptions());
      client.connect(noopCallbacks({ onDaemonRestored: () => calls.push('fired') }));
      assert.ok(lastFakeSocket);
      lastFakeSocket.simulateOpen();

      lastFakeSocket.simulateMessage({ type: 'daemon-restored' });

      assert.deepStrictEqual(calls, ['fired']);
    });

    it('dispatches error messages to onError with parsed GatewayErrorBody', () => {
      const errors: GatewayErrorBody[] = [];
      const client = createStreamClient(defaultOptions());
      client.connect(noopCallbacks({ onError: (err) => errors.push(err) }));
      assert.ok(lastFakeSocket);
      lastFakeSocket.simulateOpen();

      lastFakeSocket.simulateMessage(errorPayload());

      assert.equal(errors.length, 1);
      assert.equal(errors[0].category, 'rate-limit');
      assert.equal(errors[0].code, 'RATE_LIMITED');
      assert.equal(errors[0].message, 'Slow down');
    });

    it('dispatches error with optional fields (conversationId, turnId, retryAfterMs)', () => {
      const errors: GatewayErrorBody[] = [];
      const client = createStreamClient(defaultOptions());
      client.connect(noopCallbacks({ onError: (err) => errors.push(err) }));
      assert.ok(lastFakeSocket);
      lastFakeSocket.simulateOpen();

      lastFakeSocket.simulateMessage(
        errorPayload({
          conversationId: 'conv-99',
          turnId: 'turn-7',
          retryAfterMs: 5000,
        }),
      );

      assert.equal(errors[0].conversationId, 'conv-99');
      assert.equal(errors[0].turnId, 'turn-7');
      assert.equal(errors[0].retryAfterMs, 5000);
    });
  });

  // ─── Malformed messages ─────────────────────────────────────────────

  describe('malformed inbound messages', () => {
    it('fires onParseError for non-JSON text', () => {
      const parseErrors: Array<{ raw: string; error: string }> = [];
      const client = createStreamClient(defaultOptions());
      client.connect(
        noopCallbacks({
          onParseError: (raw, error) => parseErrors.push({ raw, error }),
        }),
      );
      assert.ok(lastFakeSocket);
      lastFakeSocket.simulateOpen();

      lastFakeSocket.simulateMessage('not json at all');

      assert.equal(parseErrors.length, 1);
      assert.equal(parseErrors[0].raw, 'not json at all');
      assert.ok(parseErrors[0].error.length > 0);
    });

    it('fires onParseError for JSON with unknown type', () => {
      const parseErrors: Array<{ raw: string; error: string }> = [];
      const client = createStreamClient(defaultOptions());
      client.connect(
        noopCallbacks({
          onParseError: (raw, error) => parseErrors.push({ raw, error }),
        }),
      );
      assert.ok(lastFakeSocket);
      lastFakeSocket.simulateOpen();

      lastFakeSocket.simulateMessage({ type: 'totally-unknown', data: 42 });

      assert.equal(parseErrors.length, 1);
      assert.ok(parseErrors[0].error.includes('unknown'));
    });

    it('does not throw if no onParseError callback is provided', () => {
      const client = createStreamClient(defaultOptions());
      client.connect(noopCallbacks());
      assert.ok(lastFakeSocket);
      lastFakeSocket.simulateOpen();

      // Should not throw
      lastFakeSocket.simulateMessage('broken json {{{');
    });
  });

  // ─── WebSocket close/error events ───────────────────────────────────

  describe('close / error events', () => {
    it('fires onClose with code and reason', () => {
      const closes: Array<{ code: number; reason: string }> = [];
      const client = createStreamClient(defaultOptions());
      client.connect(noopCallbacks({ onClose: (code, reason) => closes.push({ code, reason }) }));
      assert.ok(lastFakeSocket);
      lastFakeSocket.simulateOpen();

      lastFakeSocket.simulateClose(1006, 'Abnormal closure');

      assert.equal(closes.length, 1);
      assert.equal(closes[0].code, 1006);
      assert.equal(closes[0].reason, 'Abnormal closure');
    });

    it('fires onSocketError on WebSocket error event', () => {
      const errors: string[] = [];
      const client = createStreamClient(defaultOptions());
      client.connect(noopCallbacks({ onSocketError: () => errors.push('error') }));
      assert.ok(lastFakeSocket);
      lastFakeSocket.simulateOpen();

      lastFakeSocket.simulateError();

      assert.deepStrictEqual(errors, ['error']);
    });

    it('readyState reflects CLOSED after server-initiated close', () => {
      const client = createStreamClient(defaultOptions());
      client.connect(noopCallbacks());
      assert.ok(lastFakeSocket);
      lastFakeSocket.simulateOpen();

      lastFakeSocket.simulateClose(1001, 'Going away');

      assert.equal(client.readyState, FakeWebSocket.CLOSED);
    });
  });

  // ─── Multiple subscriptions ─────────────────────────────────────────

  describe('multiple subscribe/unsubscribe in a session', () => {
    it('sends distinct subscribe messages for each conversation', () => {
      const client = createStreamClient(defaultOptions());
      client.connect(noopCallbacks());
      assert.ok(lastFakeSocket);
      lastFakeSocket.simulateOpen();

      client.subscribe('conv-a');
      client.subscribe('conv-b');

      assert.equal(lastFakeSocket.sentMessages.length, 2);
      assert.deepStrictEqual(lastFakeSocket.sentMessages[0], {
        type: 'subscribe',
        conversationId: 'conv-a',
      });
      assert.deepStrictEqual(lastFakeSocket.sentMessages[1], {
        type: 'subscribe',
        conversationId: 'conv-b',
      });
    });

    it('routes stream-event to correct callback regardless of subscriptions', () => {
      const events: string[] = [];
      const client = createStreamClient(defaultOptions());
      client.connect(
        noopCallbacks({
          onStreamEvent: (conversationId) => events.push(conversationId),
        }),
      );
      assert.ok(lastFakeSocket);
      lastFakeSocket.simulateOpen();

      client.subscribe('conv-a');
      client.subscribe('conv-b');

      lastFakeSocket.simulateMessage(streamEventPayload({ conversationId: 'conv-b' }));
      lastFakeSocket.simulateMessage(streamEventPayload({ conversationId: 'conv-a' }));

      assert.deepStrictEqual(events, ['conv-b', 'conv-a']);
    });
  });

  // ─── Queued sends before open ───────────────────────────────────────

  describe('send before open', () => {
    it('queues subscribe calls made before the socket opens', () => {
      const client = createStreamClient(defaultOptions());
      client.connect(noopCallbacks());
      assert.ok(lastFakeSocket);

      // Socket not yet open
      assert.equal(lastFakeSocket.readyState, FakeWebSocket.CONNECTING);
      client.subscribe('conv-early');

      // Nothing sent yet
      assert.equal(lastFakeSocket.sent.length, 0);

      // Now open
      lastFakeSocket.simulateOpen();

      // Queued message should have been flushed
      assert.equal(lastFakeSocket.sentMessages.length, 1);
      assert.deepStrictEqual(lastFakeSocket.sentMessages[0], {
        type: 'subscribe',
        conversationId: 'conv-early',
      });
    });

    it('queues multiple messages and flushes in order', () => {
      const client = createStreamClient(defaultOptions());
      client.connect(noopCallbacks());
      assert.ok(lastFakeSocket);

      client.subscribe('conv-1');
      client.ack('conv-1', 0);

      lastFakeSocket.simulateOpen();

      assert.equal(lastFakeSocket.sentMessages.length, 2);
      assert.equal((lastFakeSocket.sentMessages[0] as { type: string }).type, 'subscribe');
      assert.equal((lastFakeSocket.sentMessages[1] as { type: string }).type, 'ack');
    });
  });
});
