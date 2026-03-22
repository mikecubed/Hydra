/**
 * Browser-side WebSocket stream adapter.
 *
 * Manages the connect → subscribe → ack lifecycle for real-time streaming
 * events from the gateway WebSocket transport. Reuses the exact message
 * shapes defined in the gateway's ws-protocol.ts without importing from
 * the gateway directly (boundary rule).
 *
 * All server message types are dispatched to typed callbacks. Known
 * message shapes are validated with Zod schemas that mirror the server
 * protocol in a browser-safe way (no gateway imports). Messages that
 * fail JSON parsing, have an unrecognized `type` field, or fail schema
 * validation fire an optional `onParseError` callback.
 *
 * After a server-initiated close, the socket reference is cleared and
 * sends throw instead of silently queuing onto a dead socket. Queuing
 * only occurs while the socket is CONNECTING (pre-open).
 *
 * The WebSocket constructor is injectable via `createWebSocket` for
 * testability — defaults to `globalThis.WebSocket`.
 */

import { z } from 'zod';
import { StreamEvent as StreamEventSchema } from '@hydra/web-contracts';
import type { StreamEvent } from '@hydra/web-contracts';

import { type GatewayErrorBody, parseGatewayError } from '../../../shared/gateway-errors.ts';

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
const WS_CONNECTING = 0;

// ─── Server message schemas (mirror gateway wire shapes, browser-safe) ──────

/** Terminal session states the server may send in session-terminated. */
const TerminalSessionState = z.enum(['expired', 'invalidated', 'logged-out']);

const ServerStreamEvent = z.object({
  type: z.literal('stream-event'),
  conversationId: z.string().min(1),
  event: StreamEventSchema,
});

const ServerSubscribed = z.object({
  type: z.literal('subscribed'),
  conversationId: z.string().min(1),
  currentSeq: z.number().int().nonnegative(),
});

const ServerUnsubscribed = z.object({
  type: z.literal('unsubscribed'),
  conversationId: z.string().min(1),
});

const ServerSessionTerminated = z.object({
  type: z.literal('session-terminated'),
  state: TerminalSessionState,
  reason: z.string().min(1).optional(),
});

const ServerSessionExpiringSoon = z.object({
  type: z.literal('session-expiring-soon'),
  expiresAt: z.iso.datetime(),
});

const ServerDaemonUnavailable = z.object({ type: z.literal('daemon-unavailable') });
const ServerDaemonRestored = z.object({ type: z.literal('daemon-restored') });

// Error: confirms type field then routes payload through gateway error parser.
const ServerError = z.object({ type: z.literal('error') }).loose();

// ─── Internals ──────────────────────────────────────────────────────────────

/** Type-narrowing helper for plain objects. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validate a gateway error wire shape into a GatewayErrorBody.
 * Returns null when the payload does not match the full gateway error shape,
 * so the caller can route to onParseError instead of silently synthesizing.
 */
function toGatewayError(raw: Record<string, unknown>): GatewayErrorBody | null {
  return parseGatewayError(raw);
}

/** Per-type dispatch handlers. Each validates the message shape before dispatching. */
function handleStreamEvent(msg: Record<string, unknown>, cb: StreamClientCallbacks): string | null {
  const result = ServerStreamEvent.safeParse(msg);
  if (!result.success) return result.error.message;
  cb.onStreamEvent?.(result.data.conversationId, result.data.event);
  return null;
}

function handleSubscribed(msg: Record<string, unknown>, cb: StreamClientCallbacks): string | null {
  const result = ServerSubscribed.safeParse(msg);
  if (!result.success) return result.error.message;
  cb.onSubscribed?.(result.data.conversationId, result.data.currentSeq);
  return null;
}

function handleUnsubscribed(
  msg: Record<string, unknown>,
  cb: StreamClientCallbacks,
): string | null {
  const result = ServerUnsubscribed.safeParse(msg);
  if (!result.success) return result.error.message;
  cb.onUnsubscribed?.(result.data.conversationId);
  return null;
}

function handleSessionTerminated(
  msg: Record<string, unknown>,
  cb: StreamClientCallbacks,
): string | null {
  const result = ServerSessionTerminated.safeParse(msg);
  if (!result.success) return result.error.message;
  cb.onSessionTerminated?.(result.data.state, result.data.reason);
  return null;
}

function handleSessionExpiringSoon(
  msg: Record<string, unknown>,
  cb: StreamClientCallbacks,
): string | null {
  const result = ServerSessionExpiringSoon.safeParse(msg);
  if (!result.success) return result.error.message;
  cb.onSessionExpiringSoon?.(result.data.expiresAt);
  return null;
}

function handleDaemonUnavailable(
  msg: Record<string, unknown>,
  cb: StreamClientCallbacks,
): string | null {
  const result = ServerDaemonUnavailable.safeParse(msg);
  if (!result.success) return result.error.message;
  cb.onDaemonUnavailable?.();
  return null;
}

function handleDaemonRestored(
  msg: Record<string, unknown>,
  cb: StreamClientCallbacks,
): string | null {
  const result = ServerDaemonRestored.safeParse(msg);
  if (!result.success) return result.error.message;
  cb.onDaemonRestored?.();
  return null;
}

function handleError(msg: Record<string, unknown>, cb: StreamClientCallbacks): string | null {
  const result = ServerError.safeParse(msg);
  if (!result.success) return result.error.message;
  const body = toGatewayError(msg);
  if (!body) return 'error message does not match expected gateway error shape';
  cb.onError?.(body);
  return null;
}

type MessageHandler = (msg: Record<string, unknown>, cb: StreamClientCallbacks) => string | null;

/** Explicit type→handler dispatcher. Returns null for unknown types. */
function resolveHandler(messageType: string): MessageHandler | null {
  switch (messageType) {
    case 'stream-event':
      return handleStreamEvent;
    case 'subscribed':
      return handleSubscribed;
    case 'unsubscribed':
      return handleUnsubscribed;
    case 'session-terminated':
      return handleSessionTerminated;
    case 'session-expiring-soon':
      return handleSessionExpiringSoon;
    case 'daemon-unavailable':
      return handleDaemonUnavailable;
    case 'daemon-restored':
      return handleDaemonRestored;
    case 'error':
      return handleError;
    default:
      return null;
  }
}

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

  const messageType = parsed['type'];
  const handler = resolveHandler(messageType);
  if (!handler) {
    callbacks.onParseError?.(raw, `Message has unknown type: "${messageType}"`);
    return;
  }

  const validationError = handler(parsed, callbacks);
  if (validationError !== null) {
    callbacks.onParseError?.(raw, `Invalid "${messageType}" message: ${validationError}`);
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────

/** Mutable internal state shared between the factory closure and helpers. */
interface ClientState {
  socket: WebSocketLike | null;
  sendQueue: string[];
  /** Socket intentionally closed via close() whose async onclose hasn't fired yet. */
  pendingCloseSocket: WebSocketLike | null;
}

function requireSocket(state: ClientState): WebSocketLike {
  if (state.socket === null) {
    throw new Error('StreamClient is not connected — call connect() first');
  }
  return state.socket;
}

function sendOrQueue(state: ClientState, data: string): void {
  const ws = requireSocket(state);
  if (ws.readyState === WS_OPEN) {
    ws.send(data);
  } else if (ws.readyState === WS_CONNECTING) {
    state.sendQueue.push(data);
  } else {
    throw new Error('StreamClient socket is closing or closed — cannot send');
  }
}

function flushQueue(state: ClientState): void {
  if (state.socket === null) return;
  const pending = state.sendQueue;
  state.sendQueue = [];
  for (const msg of pending) {
    state.socket.send(msg);
  }
}

function attachSocketHandlers(
  state: ClientState,
  ws: WebSocketLike,
  callbacks: StreamClientCallbacks,
): void {
  ws.onopen = () => {
    if (state.socket !== ws) return;
    flushQueue(state);
    callbacks.onOpen?.();
  };
  ws.onmessage = (ev) => {
    if (state.socket !== ws) return;
    const raw = typeof ev.data === 'string' ? ev.data : String(ev.data);
    dispatchServerMessage(raw, callbacks);
  };
  ws.onerror = () => {
    if (state.socket !== ws) return;
    callbacks.onSocketError?.();
  };
  ws.onclose = (ev) => {
    if (state.socket === ws) {
      // Server-initiated close of the active socket.
      state.socket = null;
      state.sendQueue = [];
      callbacks.onClose?.(ev.code, ev.reason);
    } else if (state.pendingCloseSocket === ws) {
      // Client-initiated close() already cleared state.socket; the browser's
      // async onclose just arrived.  Notify consumers but don't touch the
      // (possibly new) active socket.
      state.pendingCloseSocket = null;
      callbacks.onClose?.(ev.code, ev.reason);
    }
    // Otherwise this is a stale close from a fully superseded socket — ignore.
  };
}

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

  const state: ClientState = {
    socket: null,
    sendQueue: [],
    pendingCloseSocket: null,
  };

  return {
    connect(callbacks) {
      if (state.socket !== null && state.socket.readyState !== state.socket.CLOSED) {
        throw new Error('StreamClient is already connected — call close() first');
      }

      state.sendQueue = [];
      // A new connection supersedes any socket pending its async onclose.
      state.pendingCloseSocket = null;
      const ws = createWs(baseUrl);
      state.socket = ws;
      attachSocketHandlers(state, ws, callbacks);
    },

    subscribe(conversationId, lastAcknowledgedSeq) {
      const msg: Record<string, unknown> = { type: 'subscribe', conversationId };
      if (lastAcknowledgedSeq !== undefined) msg['lastAcknowledgedSeq'] = lastAcknowledgedSeq;
      sendOrQueue(state, JSON.stringify(msg));
    },

    unsubscribe(conversationId) {
      // After close() or socket teardown, unsubscribe is a safe no-op.
      if (state.socket === null || state.socket.readyState > WS_OPEN) return;
      sendOrQueue(state, JSON.stringify({ type: 'unsubscribe', conversationId }));
    },

    ack(conversationId, seq) {
      sendOrQueue(state, JSON.stringify({ type: 'ack', conversationId, seq }));
    },

    close() {
      if (state.socket === null) return;
      state.sendQueue = [];
      state.pendingCloseSocket = state.socket;
      state.socket.close();
      state.socket = null;
    },

    get readyState() {
      return state.socket?.readyState ?? WS_CLOSED;
    },
  };
}
