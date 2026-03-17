import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getRequestListener } from '@hono/node-server';
import type { StreamEvent } from '@hydra/web-contracts';
import WebSocket from 'ws';
import { createGatewayApp, type GatewayApp } from '../../index.ts';
import { FakeClock } from '../../shared/clock.ts';
import { GatewayError } from '../../shared/errors.ts';
import type { StreamEventPayload } from '../event-forwarder.ts';

const ORIGIN = 'http://127.0.0.1:4174';

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const address = server.address();
  if (address == null || typeof address === 'string') {
    throw new Error('Expected TCP server address');
  }
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function waitForCloseOrError(ws: WebSocket): Promise<void> {
  await new Promise<void>((resolve) => {
    ws.once('close', () => {
      resolve();
    });
    ws.once('error', () => {
      resolve();
    });
  });
}

async function waitForMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  const [data] = (await once(ws, 'message')) as [WebSocket.RawData];
  let payload: Buffer | Uint8Array | string;
  if (typeof data === 'string') {
    payload = data;
  } else if (Array.isArray(data)) {
    payload = Buffer.concat(data);
  } else if (data instanceof ArrayBuffer) {
    payload = new Uint8Array(data);
  } else {
    payload = data;
  }

  const text = typeof payload === 'string' ? payload : new TextDecoder().decode(payload);
  return JSON.parse(text) as Record<string, unknown>;
}

class FakeEventBridge {
  readonly #listeners = new Set<(payload: StreamEventPayload) => void>();

  on(_eventName: 'stream-event', listener: (payload: StreamEventPayload) => void): this {
    this.#listeners.add(listener);
    return this;
  }

  removeListener(
    _eventName: 'stream-event',
    listener: (payload: StreamEventPayload) => void,
  ): this {
    this.#listeners.delete(listener);
    return this;
  }

  emitStreamEvent(conversationId: string, event: StreamEvent): void {
    const payload: StreamEventPayload = { conversationId, event };
    for (const listener of this.#listeners) {
      listener(payload);
    }
  }
}

function makeStreamEvent(seq: number): StreamEvent {
  return {
    seq,
    turnId: `turn-${seq}`,
    kind: 'text-delta',
    payload: { text: `chunk-${seq}` },
    timestamp: new Date().toISOString(),
  };
}

function createWsDaemonClient(validConversationIds: ReadonlySet<string>) {
  return {
    async openConversation(conversationId: string) {
      if (validConversationIds.has(conversationId)) {
        return {
          data: {
            conversation: {
              id: conversationId,
              status: 'active' as const,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              turnCount: 0,
              pendingInstructionCount: 0,
            },
            recentTurns: [],
            totalTurnCount: 0,
            pendingApprovals: [],
          },
        };
      }
      return {
        error: {
          ok: false as const,
          code: 'CONVERSATION_NOT_FOUND',
          category: 'validation' as const,
          message: 'Conversation not found',
        },
      };
    },
    async loadTurnHistory() {
      return { data: { turns: [], totalCount: 0, hasMore: false } };
    },
    async getStreamReplay() {
      return { data: { events: [] } };
    },
  };
}

async function waitForMessages(
  ws: WebSocket,
  count: number,
): Promise<Array<Record<string, unknown>>> {
  return await new Promise((resolve) => {
    const messages: Array<Record<string, unknown>> = [];
    const onMessage = (data: WebSocket.RawData) => {
      let payload: Buffer | Uint8Array | string;
      if (typeof data === 'string') {
        payload = data;
      } else if (Array.isArray(data)) {
        payload = Buffer.concat(data);
      } else if (data instanceof ArrayBuffer) {
        payload = new Uint8Array(data);
      } else {
        payload = data;
      }

      const text = typeof payload === 'string' ? payload : new TextDecoder().decode(payload);
      messages.push(JSON.parse(text) as Record<string, unknown>);
      if (messages.length === count) {
        ws.off('message', onMessage);
        resolve(messages);
      }
    };

    ws.on('message', onMessage);
  });
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

async function connectWebSocket(
  port: number,
  options: {
    path?: string;
    origin?: string;
    sessionId?: string;
  } = {},
): Promise<WebSocket> {
  const headers: Record<string, string> = {
    Origin: options.origin ?? ORIGIN,
  };
  if (options.sessionId != null) {
    headers['Cookie'] = `__session=${options.sessionId}`;
  }

  const ws = new WebSocket(`ws://127.0.0.1:${port}${options.path ?? '/ws'}`, { headers });
  await once(ws, 'open');
  return ws;
}

function createWebSocket(
  port: number,
  options: {
    path?: string;
    origin?: string;
    sessionId?: string;
  } = {},
): WebSocket {
  const headers: Record<string, string> = {
    Origin: options.origin ?? ORIGIN,
  };
  if (options.sessionId != null) {
    headers['Cookie'] = `__session=${options.sessionId}`;
  }

  return new WebSocket(`ws://127.0.0.1:${port}${options.path ?? '/ws'}`, { headers });
}

async function expectUnexpectedResponse(
  port: number,
  options: {
    path?: string;
    origin?: string;
    sessionId?: string;
  } = {},
): Promise<number> {
  const headers: Record<string, string> = {
    Origin: options.origin ?? ORIGIN,
  };
  if (options.sessionId != null) {
    headers['Cookie'] = `__session=${options.sessionId}`;
  }

  const ws = new WebSocket(`ws://127.0.0.1:${port}${options.path ?? '/ws'}`, { headers });
  const [, response] = (await once(ws, 'unexpected-response')) as [
    unknown,
    { statusCode?: number },
  ];
  return response.statusCode ?? 0;
}

async function expectUnexpectedResponseBody(
  port: number,
  options: {
    path?: string;
    origin?: string;
    sessionId?: string;
  } = {},
): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = {
    Origin: options.origin ?? ORIGIN,
  };
  if (options.sessionId != null) {
    headers['Cookie'] = `__session=${options.sessionId}`;
  }

  const ws = new WebSocket(`ws://127.0.0.1:${port}${options.path ?? '/ws'}`, { headers });
  const [, response] = (await once(ws, 'unexpected-response')) as [
    unknown,
    NodeJS.ReadableStream & { statusCode?: number },
  ];

  const chunks: Buffer[] = [];
  response.on('data', (chunk: Buffer | string) => {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  });
  await once(response, 'end');

  return {
    status: response.statusCode ?? 0,
    body: Buffer.concat(chunks).toString('utf8'),
  };
}

describe('GatewayWsServer', () => {
  let server: Server;
  let gw: GatewayApp;
  let port: number;
  let clock: FakeClock;
  let healthResult: boolean;
  let streamEventBridge: FakeEventBridge;
  const openSockets: WebSocket[] = [];

  beforeEach(async () => {
    server = createServer();
    clock = new FakeClock(Date.now());
    healthResult = true;
    streamEventBridge = new FakeEventBridge();

    gw = createGatewayApp({
      server,
      clock,
      allowedOrigin: ORIGIN,
      healthChecker: async () => healthResult,
      wsDaemonClient: createWsDaemonClient(new Set(['conv-1', 'conv-2'])),
      streamEventBridge,
      heartbeatConfig: { intervalMs: 60_000 },
      sessionConfig: {
        sessionLifetimeMs: 60_000,
        warningThresholdMs: 10_000,
        maxExtensions: 3,
        extensionDurationMs: 60_000,
        idleTimeoutMs: 30_000,
      },
    });

    const requestListener = getRequestListener(gw.app.fetch);
    server.on('request', (request, response) => {
      void requestListener(request, response);
    });
    port = await listen(server);
  });

  afterEach(async () => {
    for (const socket of openSockets.splice(0)) {
      socket.close();
    }
    gw.wsServer?.close();
    gw.heartbeat.stop();
    await closeServer(server);
  });

  it('accepts a valid session and registers the connection', async () => {
    const session = await gw.sessionService.create('op-1', '127.0.0.1');
    const ws = await connectWebSocket(port, { sessionId: session.id });
    openSockets.push(ws);

    assert.equal(gw.connectionRegistry.getBySession(session.id).size, 1);
  });

  it('handles subscribe messages over websocket and updates conversation subscriptions', async () => {
    const session = await gw.sessionService.create('op-1', '127.0.0.1');
    const ws = await connectWebSocket(port, { sessionId: session.id });
    openSockets.push(ws);

    ws.send(JSON.stringify({ type: 'subscribe', conversationId: 'conv-1' }));

    const message = await waitForMessage(ws);
    assert.equal(message['type'], 'subscribed');
    assert.equal(message['conversationId'], 'conv-1');
    assert.equal(message['currentSeq'], 0);
    assert.equal(gw.connectionRegistry.getByConversation('conv-1').size, 1);
  });

  it('serializes subscribe then unsubscribe so stale subscribe completion does not leave the connection subscribed', async () => {
    const localServer = createServer();
    const pendingOpen =
      createDeferred<
        Awaited<ReturnType<ReturnType<typeof createWsDaemonClient>['openConversation']>>
      >();
    const localGateway = createGatewayApp({
      server: localServer,
      clock,
      allowedOrigin: ORIGIN,
      healthChecker: async () => true,
      heartbeatConfig: { intervalMs: 60_000 },
      wsDaemonClient: {
        openConversation: async () => pendingOpen.promise,
        async loadTurnHistory() {
          return { data: { turns: [], totalCount: 0, hasMore: false } };
        },
        async getStreamReplay() {
          return { data: { events: [] } };
        },
      },
      streamEventBridge: new FakeEventBridge(),
    });
    const requestListener = getRequestListener(localGateway.app.fetch);
    localServer.on('request', (request, response) => {
      void requestListener(request, response);
    });
    const localPort = await listen(localServer);

    try {
      const session = await localGateway.sessionService.create('op-1', '127.0.0.1');
      const ws = await connectWebSocket(localPort, { sessionId: session.id });
      openSockets.push(ws);

      ws.send(JSON.stringify({ type: 'subscribe', conversationId: 'conv-1' }));
      ws.send(JSON.stringify({ type: 'unsubscribe', conversationId: 'conv-1' }));

      pendingOpen.resolve({
        data: {
          conversation: {
            id: 'conv-1',
            status: 'active',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            turnCount: 0,
            pendingInstructionCount: 0,
          },
          recentTurns: [],
          totalTurnCount: 0,
          pendingApprovals: [],
        },
      });

      const messages = await waitForMessages(ws, 2);
      assert.deepEqual(
        messages.map((message) => message['type']),
        ['subscribed', 'unsubscribed'],
      );
      assert.equal(localGateway.connectionRegistry.getByConversation('conv-1').size, 0);
    } finally {
      localGateway.wsServer?.close();
      localGateway.heartbeat.stop();
      await closeServer(localServer);
    }
  });

  it('does not replay buffered events twice for duplicate subscribe frames on the same connection', async () => {
    const localServer = createServer();
    const pendingOpen =
      createDeferred<
        Awaited<ReturnType<ReturnType<typeof createWsDaemonClient>['openConversation']>>
      >();
    const localGateway = createGatewayApp({
      server: localServer,
      clock,
      allowedOrigin: ORIGIN,
      healthChecker: async () => true,
      heartbeatConfig: { intervalMs: 60_000 },
      wsDaemonClient: {
        openConversation: async () => pendingOpen.promise,
        async loadTurnHistory() {
          return { data: { turns: [], totalCount: 0, hasMore: false } };
        },
        async getStreamReplay() {
          return { data: { events: [] } };
        },
      },
      streamEventBridge: new FakeEventBridge(),
    });
    localGateway.eventBuffer.push('conv-1', makeStreamEvent(1));
    const requestListener = getRequestListener(localGateway.app.fetch);
    localServer.on('request', (request, response) => {
      void requestListener(request, response);
    });
    const localPort = await listen(localServer);

    try {
      const session = await localGateway.sessionService.create('op-1', '127.0.0.1');
      const ws = await connectWebSocket(localPort, { sessionId: session.id });
      openSockets.push(ws);

      const subscribe = JSON.stringify({
        type: 'subscribe',
        conversationId: 'conv-1',
        lastAcknowledgedSeq: 0,
      });
      ws.send(subscribe);
      ws.send(subscribe);

      pendingOpen.resolve({
        data: {
          conversation: {
            id: 'conv-1',
            status: 'active',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            turnCount: 0,
            pendingInstructionCount: 0,
          },
          recentTurns: [],
          totalTurnCount: 0,
          pendingApprovals: [],
        },
      });

      const messages = await waitForMessages(ws, 3);
      assert.equal(messages.filter((message) => message['type'] === 'stream-event').length, 1);
      assert.equal(messages.filter((message) => message['type'] === 'subscribed').length, 2);
    } finally {
      localGateway.wsServer?.close();
      localGateway.heartbeat.stop();
      await closeServer(localServer);
    }
  });

  it('closes connections that exceed the inbound websocket message queue limit', async () => {
    const localServer = createServer();
    const pendingOpen =
      createDeferred<
        Awaited<ReturnType<ReturnType<typeof createWsDaemonClient>['openConversation']>>
      >();
    let openCalls = 0;
    const localGateway = createGatewayApp({
      server: localServer,
      clock,
      allowedOrigin: ORIGIN,
      healthChecker: async () => true,
      heartbeatConfig: { intervalMs: 60_000 },
      wsDaemonClient: {
        openConversation: async () => {
          openCalls += 1;
          return await pendingOpen.promise;
        },
        async loadTurnHistory() {
          return { data: { turns: [], totalCount: 0, hasMore: false } };
        },
        async getStreamReplay() {
          return { data: { events: [] } };
        },
      },
      streamEventBridge: new FakeEventBridge(),
    });
    const requestListener = getRequestListener(localGateway.app.fetch);
    localServer.on('request', (request, response) => {
      void requestListener(request, response);
    });
    const localPort = await listen(localServer);

    try {
      const session = await localGateway.sessionService.create('op-1', '127.0.0.1');
      const ws = await connectWebSocket(localPort, { sessionId: session.id });
      openSockets.push(ws);

      for (let index = 0; index < 65; index += 1) {
        ws.send(JSON.stringify({ type: 'subscribe', conversationId: 'conv-1' }));
      }

      const message = await waitForMessage(ws);
      assert.equal(message['type'], 'error');
      assert.equal(message['code'], 'WS_MESSAGE_QUEUE_OVERFLOW');
      assert.equal(message['category'], 'rate-limit');
      await waitForCloseOrError(ws);
      assert.equal(openCalls, 1);
    } finally {
      pendingOpen.resolve({
        data: {
          conversation: {
            id: 'conv-1',
            status: 'active',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            turnCount: 0,
            pendingInstructionCount: 0,
          },
          recentTurns: [],
          totalTurnCount: 0,
          pendingApprovals: [],
        },
      });
      localGateway.wsServer?.close();
      localGateway.heartbeat.stop();
      await closeServer(localServer);
    }
  });

  it('forwards bridge stream events to subscribed websocket clients', async () => {
    const session = await gw.sessionService.create('op-1', '127.0.0.1');
    const ws = await connectWebSocket(port, { sessionId: session.id });
    openSockets.push(ws);

    ws.send(JSON.stringify({ type: 'subscribe', conversationId: 'conv-1' }));
    const subscribed = await waitForMessage(ws);
    assert.equal(subscribed['type'], 'subscribed');

    const event = makeStreamEvent(3);
    streamEventBridge.emitStreamEvent('conv-1', event);

    const forwarded = await waitForMessage(ws);
    assert.equal(forwarded['type'], 'stream-event');
    assert.equal(forwarded['conversationId'], 'conv-1');
    assert.deepEqual(forwarded['event'], event);
  });

  it('rejects missing session cookie with 401', async () => {
    const status = await expectUnexpectedResponse(port);
    assert.equal(status, 401);
  });

  it('returns a structured JSON body for rejected upgrades', async () => {
    const response = await expectUnexpectedResponseBody(port);
    assert.equal(response.status, 401);
    const payload = JSON.parse(response.body) as { code?: string; ok?: boolean };
    assert.equal(payload.ok, false);
    assert.equal(payload.code, 'SESSION_NOT_FOUND');
  });

  it('rejects expired sessions with 401', async () => {
    const session = await gw.sessionService.create('op-1', '127.0.0.1');
    clock.advance(60_001);

    const status = await expectUnexpectedResponse(port, { sessionId: session.id });
    assert.equal(status, 401);
  });

  it('rejects idle sessions with 401', async () => {
    const session = await gw.sessionService.create('op-1', '127.0.0.1');
    clock.advance(30_001);

    const status = await expectUnexpectedResponse(port, { sessionId: session.id });
    assert.equal(status, 401);
  });

  it('rejects wrong origin with 403', async () => {
    const session = await gw.sessionService.create('op-1', '127.0.0.1');
    const status = await expectUnexpectedResponse(port, {
      sessionId: session.id,
      origin: 'http://evil.example.com',
    });
    assert.equal(status, 403);
  });

  it('rate limits repeated websocket upgrades from the same source', async () => {
    const session = await gw.sessionService.create('op-1', '127.0.0.1');

    for (let index = 0; index < 30; index += 1) {
      const ws = await connectWebSocket(port, { sessionId: session.id });
      openSockets.push(ws);
    }

    const response = await expectUnexpectedResponseBody(port, { sessionId: session.id });
    assert.equal(response.status, 429);
    const payload = JSON.parse(response.body) as { code?: string; ok?: boolean };
    assert.equal(payload.ok, false);
    assert.equal(payload.code, 'RATE_LIMITED');
  });

  it('shares the mutating rate-limit budget between HTTP requests and websocket upgrades', async () => {
    const localServer = createServer();
    const localGateway = createGatewayApp({
      server: localServer,
      allowedOrigin: ORIGIN,
      healthChecker: async () => true,
      heartbeatConfig: { intervalMs: 60_000 },
    });
    const requestListener = getRequestListener(localGateway.app.fetch);
    localServer.on('request', (request, response) => {
      void requestListener(request, response);
    });
    const localPort = await listen(localServer);

    try {
      const session = await localGateway.sessionService.create('op-1', '127.0.0.1');

      for (let index = 0; index < 30; index += 1) {
        const response = await fetch(`http://127.0.0.1:${localPort}/not-found`, {
          method: 'POST',
          headers: {
            Origin: ORIGIN,
          },
        });
        assert.equal(response.status, 401);
      }

      const response = await expectUnexpectedResponseBody(localPort, { sessionId: session.id });
      assert.equal(response.status, 429);
      const payload = JSON.parse(response.body) as { code?: string; ok?: boolean };
      assert.equal(payload.ok, false);
      assert.equal(payload.code, 'RATE_LIMITED');
    } finally {
      localGateway.wsServer?.close();
      localGateway.heartbeat.stop();
      await closeServer(localServer);
    }
  });

  it('destroys non-/ws upgrades without registering a connection', async () => {
    const session = await gw.sessionService.create('op-1', '127.0.0.1');
    const ws = new WebSocket(`ws://127.0.0.1:${port}/not-ws`, {
      headers: {
        Origin: ORIGIN,
        Cookie: `__session=${session.id}`,
      },
    });

    await waitForCloseOrError(ws);
    assert.equal(gw.connectionRegistry.size, 0);
  });

  it('broadcasts expiring-soon notifications to open connections', async () => {
    const session = await gw.sessionService.create('op-1', '127.0.0.1');
    const ws = await connectWebSocket(port, { sessionId: session.id });
    openSockets.push(ws);

    clock.advance(50_001);
    await gw.sessionService.validate(session.id);

    const message = await waitForMessage(ws);
    assert.equal(message['type'], 'session-expiring-soon');
  });

  it('replays expiring-soon state to sockets that connect after the warning window begins', async () => {
    const session = await gw.sessionService.create('op-1', '127.0.0.1');
    clock.advance(50_001);
    gw.sessionService.touchActivity(session.id);
    await gw.sessionService.validate(session.id);

    const ws = createWebSocket(port, { sessionId: session.id });
    const messagePromise = waitForMessage(ws);
    await once(ws, 'open');
    openSockets.push(ws);

    const message = await messagePromise;
    assert.equal(message['type'], 'session-expiring-soon');
  });

  it('broadcasts daemon outage and recovery messages', async () => {
    const session = await gw.sessionService.create('op-1', '127.0.0.1');
    const ws = await connectWebSocket(port, { sessionId: session.id });
    openSockets.push(ws);

    healthResult = false;
    await gw.heartbeat.tick();
    const down = await waitForMessage(ws);
    assert.equal(down['type'], 'daemon-unavailable');

    healthResult = true;
    await gw.heartbeat.tick();
    const up = await waitForMessage(ws);
    assert.equal(up['type'], 'daemon-restored');
  });

  it('replays daemon-unavailable state to sockets that connect after daemon failure', async () => {
    const session = await gw.sessionService.create('op-1', '127.0.0.1');
    await gw.sessionService.markDaemonDown(session.id);

    const ws = createWebSocket(port, { sessionId: session.id });
    const messagePromise = waitForMessage(ws);
    await once(ws, 'open');
    openSockets.push(ws);

    const message = await messagePromise;
    assert.equal(message['type'], 'daemon-unavailable');
  });

  it('replays expiring-soon alongside daemon-unavailable for degraded near-expiry reconnects', async () => {
    const localServer = createServer();
    const localClock = new FakeClock(Date.now());
    const localGateway = createGatewayApp({
      server: localServer,
      clock: localClock,
      allowedOrigin: ORIGIN,
      healthChecker: async () => true,
      heartbeatConfig: { intervalMs: 60_000 },
      sessionConfig: {
        sessionLifetimeMs: 500,
        warningThresholdMs: 250,
        maxExtensions: 1,
        extensionDurationMs: 500,
        idleTimeoutMs: 5_000,
      },
    });
    const requestListener = getRequestListener(localGateway.app.fetch);
    localServer.on('request', (request, response) => {
      void requestListener(request, response);
    });
    const localPort = await listen(localServer);

    try {
      const session = await localGateway.sessionService.create('op-1', '127.0.0.1');
      localClock.advance(300);
      await localGateway.sessionService.markDaemonDown(session.id);

      const ws = createWebSocket(localPort, { sessionId: session.id });
      const messagesPromise = waitForMessages(ws, 2);
      await once(ws, 'open');
      const messages = await messagesPromise;
      openSockets.push(ws);

      assert.equal(messages[0]?.['type'], 'daemon-unavailable');
      assert.equal(messages[1]?.['type'], 'session-expiring-soon');
    } finally {
      localGateway.wsServer?.close();
      localGateway.heartbeat.stop();
      await closeServer(localServer);
    }
  });

  it('returns 500 for non-GatewayError exceptions during validation', async () => {
    const sessionService = gw.sessionService;
    const session = await gw.sessionService.create('op-1', '127.0.0.1');
    const originalValidate = sessionService.validate.bind(sessionService);
    sessionService.validate = async () => {
      throw new Error('unexpected database error');
    };

    try {
      const status = await expectUnexpectedResponse(port, { sessionId: session.id });
      assert.equal(status, 500);
    } finally {
      sessionService.validate = originalValidate;
    }
  });

  it('terminates connections when the session lifetime elapses', async () => {
    const localServer = createServer();
    const localGateway = createGatewayApp({
      server: localServer,
      allowedOrigin: ORIGIN,
      healthChecker: async () => true,
      heartbeatConfig: { intervalMs: 60_000 },
      sessionConfig: {
        sessionLifetimeMs: 25,
        warningThresholdMs: 10,
        maxExtensions: 1,
        extensionDurationMs: 25,
        idleTimeoutMs: 1_000,
      },
    });
    const requestListener = getRequestListener(localGateway.app.fetch);
    localServer.on('request', (request, response) => {
      void requestListener(request, response);
    });
    const localPort = await listen(localServer);

    try {
      const session = await localGateway.sessionService.create('op-1', '127.0.0.1');
      const ws = await connectWebSocket(localPort, { sessionId: session.id });
      openSockets.push(ws);

      // Warning timer fires before hard expiry
      const warning = await waitForMessage(ws);
      assert.equal(warning['type'], 'session-expiring-soon');

      const termination = await waitForMessage(ws);
      assert.equal(termination['type'], 'session-terminated');
      await once(ws, 'close');
      assert.equal(localGateway.connectionRegistry.getBySession(session.id).size, 0);
    } finally {
      localGateway.wsServer?.close();
      localGateway.heartbeat.stop();
      await closeServer(localServer);
    }
  });

  it('terminates all session connections on logout', async () => {
    const session = await gw.sessionService.create('op-1', '127.0.0.1');
    const wsA = await connectWebSocket(port, { sessionId: session.id });
    const wsB = await connectWebSocket(port, { sessionId: session.id });
    openSockets.push(wsA, wsB);

    await gw.sessionService.logout(session.id);

    const [messageA, messageB] = await Promise.all([waitForMessage(wsA), waitForMessage(wsB)]);
    assert.equal(messageA['type'], 'session-terminated');
    assert.equal(messageB['type'], 'session-terminated');
    await Promise.all([once(wsA, 'close'), once(wsB, 'close')]);
    assert.equal(gw.connectionRegistry.getBySession(session.id).size, 0);
  });

  it('uses a standard HTTP reason phrase instead of the error message', async () => {
    const sessionService = gw.sessionService;
    const session = await sessionService.create('op-1', '127.0.0.1');
    const originalValidate = sessionService.validate.bind(sessionService);
    sessionService.validate = async () => {
      throw new GatewayError('SESSION_EXPIRED', 'Secret internal detail', 401);
    };

    try {
      const headers: Record<string, string> = {
        Origin: ORIGIN,
        Cookie: `__session=${session.id}`,
      };
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
      const [, response] = (await once(ws, 'unexpected-response')) as [
        unknown,
        NodeJS.ReadableStream & { statusCode?: number; statusMessage?: string },
      ];

      // Status line must use standard phrase, not the custom error message
      assert.equal(response.statusCode, 401);
      assert.equal(response.statusMessage, 'Unauthorized');

      // JSON body still contains the detailed message
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer | string) => {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      });
      await once(response, 'end');
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { message?: string };
      assert.equal(body.message, 'Secret internal detail');
    } finally {
      sessionService.validate = originalValidate;
    }
  });

  it('sends session-expiring-soon purely from time progression without explicit validate()', async () => {
    const localServer = createServer();
    const localGateway = createGatewayApp({
      server: localServer,
      allowedOrigin: ORIGIN,
      healthChecker: async () => true,
      heartbeatConfig: { intervalMs: 60_000 },
      sessionConfig: {
        sessionLifetimeMs: 500,
        warningThresholdMs: 250,
        maxExtensions: 1,
        extensionDurationMs: 500,
        idleTimeoutMs: 5_000,
      },
    });
    const requestListener = getRequestListener(localGateway.app.fetch);
    localServer.on('request', (request, response) => {
      void requestListener(request, response);
    });
    const localPort = await listen(localServer);

    try {
      const session = await localGateway.sessionService.create('op-1', '127.0.0.1');
      const ws = await connectWebSocket(localPort, { sessionId: session.id });
      openSockets.push(ws);

      // No explicit validate() call — warning fires purely from the scheduled timer
      const message = await waitForMessage(ws);
      assert.equal(message['type'], 'session-expiring-soon');
    } finally {
      localGateway.wsServer?.close();
      localGateway.heartbeat.stop();
      await closeServer(localServer);
    }
  });

  it('close() drains active connections and clears registry entries', async () => {
    const session = await gw.sessionService.create('op-1', '127.0.0.1');
    const ws = await connectWebSocket(port, { sessionId: session.id });
    // Do not push to openSockets — close() should handle cleanup

    assert.ok(gw.connectionRegistry.size >= 1, 'Connection should be registered');

    gw.wsServer?.close();
    await waitForCloseOrError(ws);

    assert.equal(gw.connectionRegistry.size, 0, 'Registry should be empty after close()');
  });

  it('closes connected sockets when the idle timeout elapses', async () => {
    const localServer = createServer();
    const localGateway = createGatewayApp({
      server: localServer,
      allowedOrigin: ORIGIN,
      healthChecker: async () => true,
      heartbeatConfig: { intervalMs: 60_000 },
      sessionConfig: {
        sessionLifetimeMs: 5_000,
        warningThresholdMs: 500,
        maxExtensions: 1,
        extensionDurationMs: 5_000,
        idleTimeoutMs: 25,
      },
    });
    const requestListener = getRequestListener(localGateway.app.fetch);
    localServer.on('request', (request, response) => {
      void requestListener(request, response);
    });
    const localPort = await listen(localServer);

    try {
      const session = await localGateway.sessionService.create('op-1', '127.0.0.1');
      const ws = await connectWebSocket(localPort, { sessionId: session.id });

      await waitForCloseOrError(ws);
      assert.equal(localGateway.connectionRegistry.getBySession(session.id).size, 0);
    } finally {
      localGateway.wsServer?.close();
      localGateway.heartbeat.stop();
      await closeServer(localServer);
    }
  });

  it('refreshes the idle timeout when inbound websocket messages arrive', async () => {
    const localServer = createServer();
    const localGateway = createGatewayApp({
      server: localServer,
      allowedOrigin: ORIGIN,
      healthChecker: async () => true,
      heartbeatConfig: { intervalMs: 60_000 },
      sessionConfig: {
        sessionLifetimeMs: 5_000,
        warningThresholdMs: 500,
        maxExtensions: 1,
        extensionDurationMs: 5_000,
        idleTimeoutMs: 40,
      },
    });
    const requestListener = getRequestListener(localGateway.app.fetch);
    localServer.on('request', (request, response) => {
      void requestListener(request, response);
    });
    const localPort = await listen(localServer);

    try {
      const session = await localGateway.sessionService.create('op-1', '127.0.0.1');
      const ws = await connectWebSocket(localPort, { sessionId: session.id });

      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
      ws.send('keepalive');
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 25);
      });
      assert.equal(ws.readyState, WebSocket.OPEN);

      await waitForCloseOrError(ws);
    } finally {
      localGateway.wsServer?.close();
      localGateway.heartbeat.stop();
      await closeServer(localServer);
    }
  });

  it('keeps sibling session sockets alive when one socket refreshes shared activity', async () => {
    const localServer = createServer();
    const localGateway = createGatewayApp({
      server: localServer,
      allowedOrigin: ORIGIN,
      healthChecker: async () => true,
      heartbeatConfig: { intervalMs: 60_000 },
      sessionConfig: {
        sessionLifetimeMs: 5_000,
        warningThresholdMs: 500,
        maxExtensions: 1,
        extensionDurationMs: 5_000,
        idleTimeoutMs: 50,
      },
    });
    const requestListener = getRequestListener(localGateway.app.fetch);
    localServer.on('request', (request, response) => {
      void requestListener(request, response);
    });
    const localPort = await listen(localServer);

    try {
      const session = await localGateway.sessionService.create('op-1', '127.0.0.1');
      const wsA = await connectWebSocket(localPort, { sessionId: session.id });
      const wsB = await connectWebSocket(localPort, { sessionId: session.id });

      await new Promise<void>((resolve) => {
        setTimeout(resolve, 30);
      });
      wsA.send('keepalive');
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 35);
      });

      assert.equal(wsA.readyState, WebSocket.OPEN);
      assert.equal(wsB.readyState, WebSocket.OPEN);

      await Promise.all([waitForCloseOrError(wsA), waitForCloseOrError(wsB)]);
    } finally {
      localGateway.wsServer?.close();
      localGateway.heartbeat.stop();
      await closeServer(localServer);
    }
  });
});
