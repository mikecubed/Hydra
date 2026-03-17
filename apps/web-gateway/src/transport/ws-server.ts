import type { IncomingMessage, Server } from 'node:http';
import type { Socket } from 'node:net';
import { createError, type ErrorCode, type GatewayError } from '../shared/errors.ts';
import { createGatewayErrorResponse } from '../shared/gateway-error-response.ts';
import type { SessionService } from '../session/session-service.ts';
import type { SessionStateBroadcaster } from '../session/session-state-broadcaster.ts';
import type { ConnectionRegistry } from './connection-registry.ts';
import { SessionWsBridge } from './session-ws-bridge.ts';
import { WsConnection } from './ws-connection.ts';
import { WebSocketServer } from 'ws';

interface GatewayWsServerOptions {
  server: Server;
  sessionService: SessionService;
  broadcaster: SessionStateBroadcaster;
  allowedOrigin: string;
  connectionRegistry: ConnectionRegistry;
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

const ERROR_CATEGORY_BY_CODE: Record<
  ErrorCode,
  'auth' | 'session' | 'validation' | 'daemon' | 'rate-limit'
> = {
  INVALID_CREDENTIALS: 'auth',
  RATE_LIMITED: 'rate-limit',
  ACCOUNT_DISABLED: 'auth',
  SESSION_EXPIRED: 'session',
  SESSION_INVALIDATED: 'session',
  SESSION_NOT_FOUND: 'auth',
  SESSION_NOT_IDLE: 'session',
  IDLE_TIMEOUT: 'session',
  BAD_REQUEST: 'validation',
  INTERNAL_ERROR: 'daemon',
  DAEMON_UNREACHABLE: 'daemon',
  CLOCK_UNRELIABLE: 'daemon',
  CSRF_INVALID: 'validation',
  ORIGIN_REJECTED: 'auth',
  CONVERSATION_NOT_FOUND: 'validation',
  TURN_NOT_FOUND: 'validation',
  VALIDATION_FAILED: 'validation',
  WS_INVALID_MESSAGE: 'validation',
  WS_BUFFER_OVERFLOW: 'daemon',
};

function rejectUpgrade(socket: Socket, error: GatewayError): void {
  const body = JSON.stringify(
    createGatewayErrorResponse({
      code: error.code,
      category: ERROR_CATEGORY_BY_CODE[error.code],
      message: error.message,
    }),
  );
  const statusCode = String(error.statusCode);
  socket.write(
    [
      `HTTP/1.1 ${statusCode} ${error.message}`,
      'Content-Type: application/json',
      `Content-Length: ${String(Buffer.byteLength(body))}`,
      'Connection: close',
      '',
      body,
    ].join('\r\n'),
  );
  socket.destroy();
}

export class GatewayWsServer {
  readonly #server: Server;
  readonly #sessionService: SessionService;
  readonly #allowedOrigin: string;
  readonly #connectionRegistry: ConnectionRegistry;
  readonly #wsBridge: SessionWsBridge;
  readonly #wss: WebSocketServer;

  constructor(options: GatewayWsServerOptions) {
    this.#server = options.server;
    this.#sessionService = options.sessionService;
    this.#allowedOrigin = options.allowedOrigin;
    this.#connectionRegistry = options.connectionRegistry;
    this.#wsBridge = new SessionWsBridge({
      broadcaster: options.broadcaster,
      registry: options.connectionRegistry,
    });
    this.#wss = new WebSocketServer({ noServer: true });
    this.#server.on('upgrade', this.#handleUpgrade);
  }

  get webSocketServer(): WebSocketServer {
    return this.#wss;
  }

  close(): void {
    this.#server.off('upgrade', this.#handleUpgrade);
    this.#wss.close();
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
        const cleanup = this.#wsBridge.bindSession(session, connection);
        webSocket.on('close', cleanup);
      });
    } catch (err) {
      if (err instanceof Error && 'code' in err && 'statusCode' in err) {
        rejectUpgrade(socket, err as GatewayError);
        return;
      }

      rejectUpgrade(socket, createError('INTERNAL_ERROR'));
    }
  }
}
