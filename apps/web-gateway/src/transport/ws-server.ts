import type { IncomingMessage, Server } from 'node:http';
import type { Socket } from 'node:net';
import { createError, GatewayError, ERROR_CATEGORY_MAP } from '../shared/errors.ts';
import { createGatewayErrorResponse } from '../shared/gateway-error-response.ts';
import type { Clock } from '../shared/clock.ts';
import type { SessionService } from '../session/session-service.ts';
import type { SessionStateBroadcaster } from '../session/session-state-broadcaster.ts';
import type { ConnectionRegistry } from './connection-registry.ts';
import { SessionWsBridge } from './session-ws-bridge.ts';
import { WsConnection } from './ws-connection.ts';
import { WebSocketServer, type WebSocket } from 'ws';

interface GatewayWsServerOptions {
  server: Server;
  sessionService: SessionService;
  broadcaster: SessionStateBroadcaster;
  allowedOrigin: string;
  connectionRegistry: ConnectionRegistry;
  clock: Clock;
}

const COOKIE_SEPARATOR = ';';

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

export class GatewayWsServer {
  readonly #server: Server;
  readonly #sessionService: SessionService;
  readonly #allowedOrigin: string;
  readonly #connectionRegistry: ConnectionRegistry;
  readonly #wsBridge: SessionWsBridge;
  readonly #wss: WebSocketServer;
  readonly #clock: Clock;

  constructor(options: GatewayWsServerOptions) {
    this.#server = options.server;
    this.#sessionService = options.sessionService;
    this.#allowedOrigin = options.allowedOrigin;
    this.#connectionRegistry = options.connectionRegistry;
    this.#clock = options.clock;
    this.#wsBridge = new SessionWsBridge({
      broadcaster: options.broadcaster,
      registry: options.connectionRegistry,
      clock: options.clock,
      warningThresholdMs: options.sessionService.config.warningThresholdMs,
    });
    this.#wss = new WebSocketServer({ noServer: true });
    this.#server.on('upgrade', this.#handleUpgrade);
  }

  get webSocketServer(): WebSocketServer {
    return this.#wss;
  }

  close(): void {
    this.#server.off('upgrade', this.#handleUpgrade);
    for (const client of this.#wss.clients) {
      client.terminate();
    }
    this.#wss.close();
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
        const cleanup = () => {
          if (isCleanedUp) {
            return;
          }
          isCleanedUp = true;
          this.#connectionRegistry.unregister(connection.connectionId);
          cleanupIdle();
          cleanupBridge();
        };
        const cleanupIdle = this.#bindIdleTimeout(session.id, webSocket, cleanup);
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
