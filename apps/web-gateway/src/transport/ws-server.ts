import type { IncomingMessage, Server } from 'node:http';
import type { Socket } from 'node:net';
import { createError, GatewayError, ERROR_CATEGORY_MAP } from '../shared/errors.ts';
import { createGatewayErrorResponse } from '../shared/gateway-error-response.ts';
import type { Clock } from '../shared/clock.ts';
import type { SessionService } from '../session/session-service.ts';
import type { SessionStateBroadcaster } from '../session/session-state-broadcaster.ts';
import type { SourceKeyConfig } from '../security/source-key.ts';
import { resolveSourceKeyFromParts } from '../security/source-key.ts';
import type { DaemonClient } from '../conversation/daemon-client.ts';
import type { RateLimiter } from '../auth/rate-limiter.ts';
import type { ConnectionRegistry } from './connection-registry.ts';
import type { EventBuffer } from './event-buffer.ts';
import { EventForwarder, type StreamEventBridgeLike } from './event-forwarder.ts';
import { SessionWsBridge } from './session-ws-bridge.ts';
import { WsConnection } from './ws-connection.ts';
import { MAX_INBOUND_MESSAGE_BYTES, WsMessageHandler } from './ws-message-handler.ts';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';

interface GatewayWsServerOptions {
  server: Server;
  sessionService: SessionService;
  broadcaster: SessionStateBroadcaster;
  allowedOrigin: string;
  connectionRegistry: ConnectionRegistry;
  clock: Clock;
  sourceKeyConfig?: SourceKeyConfig;
  mutatingLimiter: RateLimiter;
  daemonClient: Pick<DaemonClient, 'openConversation' | 'loadTurnHistory' | 'getStreamReplay'>;
  eventBuffer: EventBuffer;
  streamEventBridge?: StreamEventBridgeLike;
}

const COOKIE_SEPARATOR = ';';
const MAX_PENDING_MESSAGES_PER_CONNECTION = 64;

/**
 * Hard ceiling enforced by the `ws` library to protect against denial-of-service.
 * App-level policy (MAX_INBOUND_MESSAGE_BYTES) is checked in #handleSocketMessage
 * before UTF-8 decoding so that oversized messages receive a structured error
 * without terminating the connection.
 */
const WS_HARD_MAX_PAYLOAD = 1_048_576;

function parseSessionCookie(cookieHeader?: string): string | null {
  if (cookieHeader == null || cookieHeader === '') {
    return null;
  }

  for (const part of cookieHeader.split(COOKIE_SEPARATOR)) {
    const [rawKey, ...rest] = part.trim().split('=');
    if (rawKey === '__session') {
      const value = rest.join('=').trim();
      return value === '' ? null : value;
    }
  }
  return null;
}

const HTTP_REASON_PHRASES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

function rejectUpgrade(socket: Socket, error: GatewayError): void {
  const body = JSON.stringify(
    createGatewayErrorResponse({
      code: error.code,
      category: ERROR_CATEGORY_MAP[error.code],
      message: error.message,
      retryAfterMs: error.retryAfterMs,
    }),
  );
  const statusCode = error.statusCode;
  const reasonPhrase = HTTP_REASON_PHRASES[statusCode] ?? 'Error';
  socket.end(
    [
      `HTTP/1.1 ${String(statusCode)} ${reasonPhrase}`,
      'Content-Type: application/json',
      `Content-Length: ${String(Buffer.byteLength(body))}`,
      'Connection: close',
      '',
      body,
    ].join('\r\n'),
  );
}

function rawDataByteLength(data: RawData): number {
  if (typeof data === 'string') {
    return Buffer.byteLength(data, 'utf8');
  }
  if (Array.isArray(data)) {
    let total = 0;
    for (const buf of data) total += buf.length;
    return total;
  }
  if (data instanceof ArrayBuffer) {
    return data.byteLength;
  }
  return data.length;
}

function rawDataToString(data: RawData): string {
  if (typeof data === 'string') {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8');
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(data));
  }
  return data.toString('utf8');
}

export class GatewayWsServer {
  readonly #server: Server;
  readonly #sessionService: SessionService;
  readonly #allowedOrigin: string;
  readonly #connectionRegistry: ConnectionRegistry;
  readonly #wsBridge: SessionWsBridge;
  readonly #wss: WebSocketServer;
  readonly #clock: Clock;
  readonly #mutatingLimiter: RateLimiter;
  readonly #trustedProxies: ReadonlySet<string> | undefined;
  readonly #messageHandler: WsMessageHandler;
  readonly #eventBuffer: EventBuffer;
  readonly #eventForwarder?: EventForwarder;
  readonly #messageQueues = new Map<string, Promise<void>>();
  readonly #messageQueueDepths = new Map<string, number>();

  constructor(options: GatewayWsServerOptions) {
    this.#server = options.server;
    this.#sessionService = options.sessionService;
    this.#allowedOrigin = options.allowedOrigin;
    this.#connectionRegistry = options.connectionRegistry;
    this.#clock = options.clock;
    this.#mutatingLimiter = options.mutatingLimiter;
    this.#eventBuffer = options.eventBuffer;
    this.#trustedProxies = options.sourceKeyConfig?.trustedProxies
      ? new Set(options.sourceKeyConfig.trustedProxies)
      : undefined;
    this.#wsBridge = new SessionWsBridge({
      broadcaster: options.broadcaster,
      registry: options.connectionRegistry,
      clock: options.clock,
      warningThresholdMs: options.sessionService.config.warningThresholdMs,
    });
    this.#wss = new WebSocketServer({
      noServer: true,
      maxPayload: WS_HARD_MAX_PAYLOAD,
    });
    this.#messageHandler = new WsMessageHandler({
      registry: options.connectionRegistry,
      buffer: options.eventBuffer,
      daemonClient: options.daemonClient,
    });
    if (options.streamEventBridge) {
      this.#eventForwarder = new EventForwarder(
        options.streamEventBridge,
        options.eventBuffer,
        options.connectionRegistry,
      );
      this.#eventForwarder.start();
    }
    this.#server.on('upgrade', this.#handleUpgrade);
  }

  get webSocketServer(): WebSocketServer {
    return this.#wss;
  }

  close(): void {
    this.#server.off('upgrade', this.#handleUpgrade);
    this.#eventForwarder?.dispose();
    for (const client of this.#wss.clients) {
      client.terminate();
    }
    this.#wss.close();
  }

  #handleSocketMessage(connection: WsConnection, data: RawData): void {
    if (rawDataByteLength(data) > MAX_INBOUND_MESSAGE_BYTES) {
      if (!connection.isClosed) {
        connection.send({
          type: 'error',
          ok: false as const,
          code: 'WS_INVALID_MESSAGE',
          category: 'validation',
          message: 'Message exceeds maximum allowed size',
        });
      }
      return;
    }

    const queuedDepth = this.#messageQueueDepths.get(connection.connectionId) ?? 0;
    if (queuedDepth >= MAX_PENDING_MESSAGES_PER_CONNECTION) {
      if (!connection.isClosed) {
        connection.send({
          type: 'error',
          ok: false as const,
          code: 'WS_MESSAGE_QUEUE_OVERFLOW',
          category: 'rate-limit',
          message: 'Too many queued websocket messages',
        });
        connection.close(1008, 'WS_MESSAGE_QUEUE_OVERFLOW');
      }
      return;
    }

    this.#messageQueueDepths.set(connection.connectionId, queuedDepth + 1);
    const prior = this.#messageQueues.get(connection.connectionId) ?? Promise.resolve();
    const next = prior
      .catch(() => {})
      .then(async () => {
        if (connection.isClosed) return;
        const rawMessage = rawDataToString(data);
        await this.#messageHandler.handleMessage(connection, rawMessage);
      })
      .catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : 'unknown error';
        console.warn('[GatewayWsServer] message handling failure', {
          connectionId: connection.connectionId,
          sessionId: connection.sessionId,
          detail,
        });
        if (!connection.isClosed) {
          connection.close(1011, 'Message handling failed');
        }
      });
    this.#messageQueues.set(connection.connectionId, next);
    void next.finally(() => {
      const remainingDepth = (this.#messageQueueDepths.get(connection.connectionId) ?? 1) - 1;
      if (remainingDepth > 0) {
        this.#messageQueueDepths.set(connection.connectionId, remainingDepth);
      } else {
        this.#messageQueueDepths.delete(connection.connectionId);
      }
      if (this.#messageQueues.get(connection.connectionId) === next) {
        this.#messageQueues.delete(connection.connectionId);
      }
    });
  }

  #bindIdleTimeout(sessionId: string, webSocket: WebSocket, onIdle: () => void): () => void {
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const clearIdleTimer = () => {
      if (idleTimer != null) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };

    const closeForIdle = () => {
      onIdle();
      webSocket.close(1000, 'Session idle timeout');
    };

    const scheduleIdleCheck = () => {
      clearIdleTimer();
      const session = this.#sessionService.store.get(sessionId);
      if (session == null || this.#sessionService.isIdle(session)) {
        closeForIdle();
        return;
      }

      const lastActivityMs = new Date(session.lastActivityAt).getTime();
      if (Number.isNaN(lastActivityMs)) {
        closeForIdle();
        return;
      }

      const elapsedMs = this.#clock.now() - lastActivityMs;
      const remainingMs = Math.max(this.#sessionService.config.idleTimeoutMs - elapsedMs, 1);
      idleTimer = setTimeout(() => {
        scheduleIdleCheck();
      }, remainingMs);
    };

    const recordActivity = () => {
      this.#sessionService.touchActivity(sessionId);
      scheduleIdleCheck();
    };

    recordActivity();
    webSocket.on('message', recordActivity);
    webSocket.on('ping', recordActivity);
    webSocket.on('pong', recordActivity);

    return () => {
      clearIdleTimer();
      webSocket.off('message', recordActivity);
      webSocket.off('ping', recordActivity);
      webSocket.off('pong', recordActivity);
    };
  }

  readonly #handleUpgrade = (request: IncomingMessage, socket: Socket, head: Buffer): void => {
    void this.#upgrade(request, socket, head);
  };

  async #upgrade(request: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    if (request.url !== '/ws') {
      socket.destroy();
      return;
    }

    const origin = request.headers.origin;
    if (origin == null || origin !== this.#allowedOrigin) {
      rejectUpgrade(socket, createError('ORIGIN_REJECTED'));
      return;
    }

    const sessionId = parseSessionCookie(request.headers.cookie);
    if (sessionId == null) {
      rejectUpgrade(socket, createError('SESSION_NOT_FOUND'));
      return;
    }

    const forwardedForHeader = request.headers['x-forwarded-for'];
    const sourceKey = resolveSourceKeyFromParts(
      request.socket.remoteAddress,
      typeof forwardedForHeader === 'string' ? forwardedForHeader : forwardedForHeader?.[0],
      this.#trustedProxies,
    );
    if (!this.#mutatingLimiter.check(sourceKey)) {
      rejectUpgrade(socket, createError('RATE_LIMITED'));
      return;
    }
    this.#mutatingLimiter.recordAttempt(sourceKey);

    try {
      const session = await this.#sessionService.validate(sessionId);
      if (this.#sessionService.isIdle(session)) {
        rejectUpgrade(socket, createError('IDLE_TIMEOUT'));
        return;
      }

      this.#wss.handleUpgrade(request, socket, head, (webSocket) => {
        const connection = WsConnection.create(session.id, webSocket, this.#connectionRegistry);
        const cleanupBridge = this.#wsBridge.bindSession(session, connection);
        let isCleanedUp = false;
        let cleanupIdle: () => void = () => {};
        const cleanup = () => {
          if (isCleanedUp) {
            return;
          }
          isCleanedUp = true;
          const affectedConversations = new Set([
            ...connection.subscribedConversations,
            ...connection.pendingConversations,
          ]);
          this.#messageQueues.delete(connection.connectionId);
          this.#messageQueueDepths.delete(connection.connectionId);
          this.#connectionRegistry.unregister(connection.connectionId);
          for (const conversationId of affectedConversations) {
            if (!this.#connectionRegistry.hasInterest(conversationId)) {
              this.#eventBuffer.markConversationInactive(conversationId);
            }
          }
          cleanupIdle();
          cleanupBridge();
        };
        cleanupIdle = this.#bindIdleTimeout(session.id, webSocket, cleanup);
        webSocket.on('message', (data) => {
          this.#handleSocketMessage(connection, data);
        });
        webSocket.on('close', cleanup);
      });
    } catch (err) {
      if (err instanceof GatewayError) {
        rejectUpgrade(socket, err);
        return;
      }

      rejectUpgrade(socket, createError('INTERNAL_ERROR'));
    }
  }
}
