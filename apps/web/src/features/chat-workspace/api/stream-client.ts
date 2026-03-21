/**
 * Browser-side WebSocket stream adapter.
 *
 * Manages the connect → subscribe → ack lifecycle for real-time streaming
 * events from the gateway WebSocket transport. Reuses the exact message
 * shapes defined in the gateway's ws-protocol.ts without importing from
 * the gateway directly (boundary rule).
 *
 * All server message types are dispatched to typed callbacks. Messages
 * that fail JSON parsing or have an unrecognized `type` field fire an
 * optional `onParseError` callback instead of silently swallowing.
 *
 * The WebSocket constructor is injectable via `createWebSocket` for
 * testability — defaults to `globalThis.WebSocket`.
 */

import type { StreamEvent } from '@hydra/web-contracts';

import {
  type GatewayErrorBody,
  type ErrorCategory,
  parseGatewayError,
} from '../../../shared/gateway-errors.ts';

// ─── WebSocket-like type (testable) ─────────────────────────────────────────

/** Minimal WebSocket interface consumed by the adapter. */
export interface WebSocketLike {
  readonly readyState: number;
  readonly CONNECTING: number;
  readonly OPEN: number;
  readonly CLOSING: number;
  readonly CLOSED: number;

  onopen: ((ev: { type: string }) => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onerror: ((ev: { type: string }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;

  send(data: string): void;
  close(code?: number, reason?: string): void;
}

// ─── Public options & callbacks ─────────────────────────────────────────────

export interface StreamClientOptions {
  /** Gateway WebSocket URL (e.g. `wss://gw.example.com/ws`). */
  readonly baseUrl: string;
  /**
   * Injectable WebSocket constructor for testing.
   * Defaults to `globalThis.WebSocket`.
   */
  readonly createWebSocket?: (url: string) => WebSocketLike;
}

/**
 * Typed callbacks for every server→client message type.
 * All are optional — unset hooks are silently skipped.
 */
export interface StreamClientCallbacks {
  /** Called when the WebSocket connection opens. */
  onOpen?: () => void;
  /** Incremental stream event for a conversation. */
  onStreamEvent?: (conversationId: string, event: StreamEvent) => void;
  /** Subscription confirmed with current server-side sequence. */
  onSubscribed?: (conversationId: string, currentSeq: number) => void;
  /** Unsubscription confirmed. */
  onUnsubscribed?: (conversationId: string) => void;
  /** Session terminated — operator should re-authenticate. */
  onSessionTerminated?: (
    state: 'expired' | 'invalidated' | 'logged-out',
    reason: string | undefined,
  ) => void;
  /** Session nearing expiry — UI may show a warning. */
  onSessionExpiringSoon?: (expiresAt: string) => void;
  /** Backend daemon is unreachable. */
  onDaemonUnavailable?: () => void;
  /** Backend daemon has recovered. */
  onDaemonRestored?: () => void;
  /** Structured gateway error. */
  onError?: (error: GatewayErrorBody) => void;
  /** WebSocket close event. */
  onClose?: (code: number, reason: string) => void;
  /** Raw WebSocket error event (network-level). */
  onSocketError?: () => void;
  /** Inbound message that could not be parsed or had an unknown type. */
  onParseError?: (raw: string, error: string) => void;
}

/** Browser-side WebSocket stream adapter. */
export interface StreamClient {
  /**
   * Open the WebSocket connection and attach callbacks.
   * Throws if already connected — call `close()` first.
   */
  connect(callbacks: StreamClientCallbacks): void;
  /** Subscribe to stream events for a conversation. */
  subscribe(conversationId: string, lastAcknowledgedSeq?: number): void;
  /** Unsubscribe from a conversation's stream events. */
  unsubscribe(conversationId: string): void;
  /** Acknowledge receipt of a sequence number. */
  ack(conversationId: string, seq: number): void;
  /** Close the WebSocket connection. Safe to call when not connected. */
  close(): void;
  /** Current WebSocket readyState (CONNECTING, OPEN, CLOSING, CLOSED). */
  readonly readyState: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const WS_CLOSED = 3;
const WS_OPEN = 1;

// ─── Internals ──────────────────────────────────────────────────────────────

/** Type-narrowing helper for plain objects. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validate a gateway error wire shape into a GatewayErrorBody.
 * Falls back to a synthetic body if `parseGatewayError` rejects the shape.
 */
function toGatewayError(raw: Record<string, unknown>): GatewayErrorBody {
  const parsed = parseGatewayError(raw);
  if (parsed) return parsed;

  // Synthetic fallback for partially-valid error messages
  return {
    ok: false,
    code: typeof raw['code'] === 'string' ? raw['code'] : 'UNKNOWN',
    category: 'daemon' as ErrorCategory,
    message: typeof raw['message'] === 'string' ? raw['message'] : 'Unknown error',
  };
}

/** Per-type dispatch handlers. Separated to keep cyclomatic complexity low. */
function handleStreamEvent(msg: Record<string, unknown>, cb: StreamClientCallbacks): void {
  cb.onStreamEvent?.(msg['conversationId'] as string, msg['event'] as StreamEvent);
}

function handleSubscribed(msg: Record<string, unknown>, cb: StreamClientCallbacks): void {
  cb.onSubscribed?.(msg['conversationId'] as string, msg['currentSeq'] as number);
}

function handleUnsubscribed(msg: Record<string, unknown>, cb: StreamClientCallbacks): void {
  cb.onUnsubscribed?.(msg['conversationId'] as string);
}

function handleSessionTerminated(msg: Record<string, unknown>, cb: StreamClientCallbacks): void {
  const state = msg['state'] as 'expired' | 'invalidated' | 'logged-out';
  const reason = typeof msg['reason'] === 'string' ? msg['reason'] : undefined;
  cb.onSessionTerminated?.(state, reason);
}

function handleSessionExpiringSoon(msg: Record<string, unknown>, cb: StreamClientCallbacks): void {
  cb.onSessionExpiringSoon?.(msg['expiresAt'] as string);
}

function handleDaemonUnavailable(_msg: Record<string, unknown>, cb: StreamClientCallbacks): void {
  cb.onDaemonUnavailable?.();
}

function handleDaemonRestored(_msg: Record<string, unknown>, cb: StreamClientCallbacks): void {
  cb.onDaemonRestored?.();
}

function handleError(msg: Record<string, unknown>, cb: StreamClientCallbacks): void {
  cb.onError?.(toGatewayError(msg));
}

type ServerMessageHandler = (msg: Record<string, unknown>, cb: StreamClientCallbacks) => void;

const SERVER_HANDLERS: ReadonlyMap<string, ServerMessageHandler> = new Map<
  string,
  ServerMessageHandler
>([
  ['stream-event', handleStreamEvent],
  ['subscribed', handleSubscribed],
  ['unsubscribed', handleUnsubscribed],
  ['session-terminated', handleSessionTerminated],
  ['session-expiring-soon', handleSessionExpiringSoon],
  ['daemon-unavailable', handleDaemonUnavailable],
  ['daemon-restored', handleDaemonRestored],
  ['error', handleError],
]);

/** Parse, validate, and dispatch a single inbound server message. */
function dispatchServerMessage(raw: string, callbacks: StreamClientCallbacks): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    callbacks.onParseError?.(raw, 'Invalid JSON');
    return;
  }

  if (!isRecord(parsed) || typeof parsed['type'] !== 'string') {
    callbacks.onParseError?.(raw, 'Message missing "type" field');
    return;
  }

  const handler = SERVER_HANDLERS.get(parsed['type']);
  if (!handler) {
    callbacks.onParseError?.(raw, `Message has unknown type: "${parsed['type']}"`);
    return;
  }

  handler(parsed, callbacks);
}

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Create a new stream client instance.
 *
 * The returned client is stateless until `connect()` is called. After
 * `close()`, the same instance can be reconnected by calling `connect()`
 * again (useful for reconnect flows).
 */
export function createStreamClient(options: StreamClientOptions): StreamClient {
  const { baseUrl } = options;
  const createWs =
    options.createWebSocket ?? ((url: string) => new WebSocket(url) as WebSocketLike);

  let socket: WebSocketLike | null = null;
  let sendQueue: string[] = [];

  function requireSocket(): WebSocketLike {
    if (socket === null) {
      throw new Error('StreamClient is not connected — call connect() first');
    }
    return socket;
  }

  function sendOrQueue(data: string): void {
    const ws = requireSocket();
    if (ws.readyState === WS_OPEN) {
      ws.send(data);
    } else {
      sendQueue.push(data);
    }
  }

  function flushQueue(): void {
    if (socket === null) return;
    const pending = sendQueue;
    sendQueue = [];
    for (const msg of pending) {
      socket.send(msg);
    }
  }

  return {
    connect(callbacks) {
      if (socket !== null && socket.readyState !== socket.CLOSED) {
        throw new Error('StreamClient is already connected — call close() first');
      }

      sendQueue = [];
      const ws = createWs(baseUrl);
      socket = ws;

      ws.onopen = () => {
        flushQueue();
        callbacks.onOpen?.();
      };

      ws.onmessage = (ev) => {
        const raw = typeof ev.data === 'string' ? ev.data : String(ev.data);
        dispatchServerMessage(raw, callbacks);
      };

      ws.onerror = () => {
        callbacks.onSocketError?.();
      };

      ws.onclose = (ev) => {
        callbacks.onClose?.(ev.code, ev.reason);
      };
    },

    subscribe(conversationId, lastAcknowledgedSeq) {
      const msg: Record<string, unknown> = {
        type: 'subscribe',
        conversationId,
      };
      if (lastAcknowledgedSeq !== undefined) {
        msg['lastAcknowledgedSeq'] = lastAcknowledgedSeq;
      }
      sendOrQueue(JSON.stringify(msg));
    },

    unsubscribe(conversationId) {
      sendOrQueue(JSON.stringify({ type: 'unsubscribe', conversationId }));
    },

    ack(conversationId, seq) {
      sendOrQueue(JSON.stringify({ type: 'ack', conversationId, seq }));
    },

    close() {
      if (socket === null) return;
      sendQueue = [];
      socket.close();
      socket = null;
    },

    get readyState() {
      return socket?.readyState ?? WS_CLOSED;
    },
  };
}
