import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getRequestListener } from '@hono/node-server';
import WebSocket from 'ws';
import { createGatewayApp, type GatewayApp } from '../../index.ts';
import { FakeClock } from '../../shared/clock.ts';

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

describe('GatewayWsServer', () => {
  let server: Server;
  let gw: GatewayApp;
  let port: number;
  let clock: FakeClock;
  let healthResult: boolean;
  const openSockets: WebSocket[] = [];

  beforeEach(async () => {
    server = createServer();
    clock = new FakeClock(Date.now());
    healthResult = true;

    gw = createGatewayApp({
      server,
      clock,
      allowedOrigin: ORIGIN,
      healthChecker: async () => healthResult,
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

  it('rejects missing session cookie with 401', async () => {
    const status = await expectUnexpectedResponse(port);
    assert.equal(status, 401);
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

      const message = await waitForMessage(ws);
      assert.equal(message['type'], 'session-terminated');
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
});
