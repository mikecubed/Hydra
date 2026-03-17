/**
 * T030 — End-to-end streaming integration test.
 *
 * Exercises the full path: authenticate → open WebSocket → subscribe to
 * conversation → submit instruction via REST → assert stream events
 * (stream-started, text-delta, stream-completed) arrive through WebSocket
 * as the daemon produces them. Verifies sequence numbers are monotonically
 * increasing across the entire event stream.
 *
 * Uses the composed gateway app with a FakeEventBridge + fake DaemonClient
 * to simulate daemon behaviour without requiring a running daemon process.
 */
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getRequestListener } from '@hono/node-server';
import type { StreamEvent } from '@hydra/web-contracts';
import WebSocket from 'ws';
import { createGatewayApp, type GatewayApp } from '../index.ts';
import { FakeClock } from '../shared/clock.ts';
import type { StreamEventPayload } from '../transport/event-forwarder.ts';
import type { DaemonClient } from '../conversation/daemon-client.ts';
import type { GatewayErrorResponse } from '../shared/gateway-error-response.ts';

const ORIGIN = 'http://127.0.0.1:4174';

// ── Helpers ──────────────────────────────────────────────────────────────────

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

function rawDataToJson(data: WebSocket.RawData): Record<string, unknown> {
  if (typeof data === 'string') {
    return JSON.parse(data) as Record<string, unknown>;
  }

  if (data instanceof ArrayBuffer) {
    return JSON.parse(new TextDecoder().decode(new Uint8Array(data))) as Record<string, unknown>;
  }

  if (Array.isArray(data)) {
    return JSON.parse(Buffer.concat(data).toString('utf8')) as Record<string, unknown>;
  }

  const parsed: unknown = JSON.parse(data.toString('utf8'));
  return parsed as Record<string, unknown>;
}

async function waitForMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  const [data] = (await once(ws, 'message')) as [WebSocket.RawData];
  return rawDataToJson(data);
}

async function waitForMessages(
  ws: WebSocket,
  count: number,
  timeoutMs = 5000,
): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const messages: Array<Record<string, unknown>> = [];
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(
        new Error(
          `Timed out waiting for ${String(count)} messages; received ${String(messages.length)}`,
        ),
      );
    }, timeoutMs);

    function onMessage(data: WebSocket.RawData) {
      messages.push(rawDataToJson(data));
      if (messages.length === count) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(messages);
      }
    }

    ws.on('message', onMessage);
  });
}

async function waitFor<T>(
  read: () => T,
  predicate: (value: T) => boolean,
  timeoutMs = 5000,
): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    const value = read();
    if (predicate(value)) {
      return value;
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
}

function assertMonotonicSequenceNumbers(seqs: number[], description: string): void {
  const pairs = seqs.slice(1).entries();
  for (const [offset, seq] of pairs) {
    const previous = seqs[offset];
    assert.ok(
      seq > previous,
      `${description}: seq[${String(offset + 1)}]=${String(seq)} should be > seq[${String(offset)}]=${String(previous)}`,
    );
  }
}

function lastItem<T>(items: T[]): T {
  // eslint-disable-next-line unicorn/prefer-at -- `.at()` conflicts with this package's Node compatibility lint rule.
  const item = items[items.length - 1];
  if (item === undefined) {
    throw new Error('Expected non-empty array');
  }
  return item;
}

async function connectWebSocket(
  port: number,
  options: { sessionId: string; origin?: string },
): Promise<WebSocket> {
  const headers: Record<string, string> = {
    Origin: options.origin ?? ORIGIN,
    Cookie: `__session=${options.sessionId}`,
  };
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
  await once(ws, 'open');
  return ws;
}

// ── Fake EventBridge ─────────────────────────────────────────────────────────

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

// ── Fake DaemonClient ────────────────────────────────────────────────────────

/** Builds a fake DaemonClient that tracks submitted instructions and returns
 *  predictable responses. The bridge + sequence generator allow us to simulate
 *  the daemon emitting stream events in response to instruction submission.
 */
function createFakeDaemonClient(
  bridge: FakeEventBridge,
  options: {
    validConversationIds: ReadonlySet<string>;
    seqStart?: number;
  },
): {
  daemonClient: DaemonClient;
  wsDaemonClient: Pick<DaemonClient, 'openConversation' | 'loadTurnHistory' | 'getStreamReplay'>;
  submissions: Array<{ conversationId: string; instruction: string; turnId: string }>;
  emitFullStream: (conversationId: string, turnId: string, textChunks: string[]) => StreamEvent[];
} {
  let seq = options.seqStart ?? 1;
  let turnCounter = 0;
  const submissions: Array<{ conversationId: string; instruction: string; turnId: string }> = [];

  const notFoundError: GatewayErrorResponse = {
    ok: false,
    code: 'CONVERSATION_NOT_FOUND',
    category: 'validation',
    message: 'Conversation not found',
  };

  const openConversation = async (conversationId: string) => {
    if (options.validConversationIds.has(conversationId)) {
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
    return { error: notFoundError };
  };

  /** Emit a complete stream lifecycle: started → N text-deltas → completed.
   *  Returns the emitted events for assertion convenience. */
  const emitFullStream = (
    conversationId: string,
    turnId: string,
    textChunks: string[],
  ): StreamEvent[] => {
    const events: StreamEvent[] = [];

    const started: StreamEvent = {
      seq: seq++,
      turnId,
      kind: 'stream-started',
      payload: { streamId: `stream-${turnId}` },
      timestamp: new Date().toISOString(),
    };
    events.push(started);
    bridge.emitStreamEvent(conversationId, started);

    for (const text of textChunks) {
      const delta: StreamEvent = {
        seq: seq++,
        turnId,
        kind: 'text-delta',
        payload: { text },
        timestamp: new Date().toISOString(),
      };
      events.push(delta);
      bridge.emitStreamEvent(conversationId, delta);
    }

    const completed: StreamEvent = {
      seq: seq++,
      turnId,
      kind: 'stream-completed',
      payload: { responseLength: textChunks.join('').length },
      timestamp: new Date().toISOString(),
    };
    events.push(completed);
    bridge.emitStreamEvent(conversationId, completed);

    return events;
  };

  // Minimal DaemonClient fake — only methods used by conversation routes.
  // submitInstruction simulates the daemon accepting and recording the turn.
  const daemonClient = {
    openConversation,
    async submitInstruction(
      conversationId: string,
      body: { instruction: string },
      _opts?: { sessionId: string },
    ) {
      if (!options.validConversationIds.has(conversationId)) {
        return { error: notFoundError };
      }
      turnCounter++;
      const turnId = `turn-${String(turnCounter)}`;
      submissions.push({ conversationId, instruction: body.instruction, turnId });
      return {
        data: {
          turn: {
            id: turnId,
            conversationId,
            position: turnCounter,
            role: 'user',
            instruction: body.instruction,
            status: 'streaming',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          streamId: `stream-${turnId}`,
        },
      };
    },
    async createConversation(body: { title?: string }) {
      const id = `conv-${String(Date.now())}`;
      return {
        data: {
          id,
          status: 'active',
          title: body.title ?? '',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          turnCount: 0,
          pendingInstructionCount: 0,
        },
      };
    },
  } as unknown as DaemonClient;

  const wsDaemonClient: Pick<
    DaemonClient,
    'openConversation' | 'loadTurnHistory' | 'getStreamReplay'
  > = {
    openConversation,
    async loadTurnHistory() {
      return { data: { turns: [], totalCount: 0, hasMore: false } };
    },
    async getStreamReplay() {
      return { data: { events: [] } };
    },
  };

  return { daemonClient, wsDaemonClient, submissions, emitFullStream };
}

// ── Test suite ───────────────────────────────────────────────────────────────

describe('T030: End-to-end streaming integration', () => {
  let server: Server;
  let gw: GatewayApp;
  let port: number;
  let clock: FakeClock;
  let bridge: FakeEventBridge;
  let fakeDaemon: ReturnType<typeof createFakeDaemonClient>;
  const openSockets: WebSocket[] = [];

  const CONV_ID = 'conv-e2e-1';

  beforeEach(async () => {
    server = createServer();
    clock = new FakeClock(Date.now());
    bridge = new FakeEventBridge();

    fakeDaemon = createFakeDaemonClient(bridge, {
      validConversationIds: new Set([CONV_ID, 'conv-e2e-2']),
    });

    gw = createGatewayApp({
      server,
      clock,
      allowedOrigin: ORIGIN,
      healthChecker: async () => true,
      heartbeatConfig: { intervalMs: 60_000 },
      daemonClient: fakeDaemon.daemonClient,
      wsDaemonClient: fakeDaemon.wsDaemonClient,
      streamEventBridge: bridge,
      sessionConfig: {
        sessionLifetimeMs: 3600_000,
        warningThresholdMs: 600_000,
        maxExtensions: 3,
        extensionDurationMs: 3600_000,
        idleTimeoutMs: 1800_000,
      },
    });

    const requestListener = getRequestListener(gw.app.fetch);
    server.on('request', (request, response) => {
      void requestListener(request, response);
    });
    port = await listen(server);

    // Seed an operator for login
    await gw.operatorStore.createOperator('admin', 'Admin');
    await gw.operatorStore.addCredential('admin', 'password123');
  });

  afterEach(async () => {
    for (const socket of openSockets.splice(0)) {
      socket.close();
    }
    gw.wsServer?.close();
    gw.heartbeat.stop();
    await closeServer(server);
  });

  // ── REST login helper ────────────────────────────────────────────────────

  async function loginViaRest(): Promise<{ sessionId: string; csrfToken: string }> {
    const res = await fetch(`http://127.0.0.1:${port}/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: ORIGIN,
      },
      body: JSON.stringify({ identity: 'admin', secret: 'password123' }),
    });
    assert.equal(res.status, 200, `Login failed with status ${String(res.status)}`);

    const setCookies = res.headers.getSetCookie();
    let sessionId = '';
    let csrfToken = '';
    for (const sc of setCookies) {
      const [pair] = sc.split(';');
      const eqIdx = pair.indexOf('=');
      if (eqIdx > 0) {
        const key = pair.slice(0, eqIdx).trim();
        const value = pair.slice(eqIdx + 1).trim();
        if (key === '__session') sessionId = value;
        if (key === '__csrf') csrfToken = value;
      }
    }
    assert.ok(sessionId, 'Expected __session cookie');
    assert.ok(csrfToken, 'Expected __csrf cookie');
    return { sessionId, csrfToken };
  }

  // ── REST instruction submission helper ─────────────────────────────────

  async function submitInstructionViaRest(
    conversationId: string,
    instruction: string,
    auth: { sessionId: string; csrfToken: string },
  ): Promise<Record<string, unknown>> {
    const res = await fetch(`http://127.0.0.1:${port}/conversations/${conversationId}/turns`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: ORIGIN,
        Cookie: `__session=${auth.sessionId}; __csrf=${auth.csrfToken}`,
        'X-CSRF-Token': auth.csrfToken,
      },
      body: JSON.stringify({ instruction }),
    });
    assert.equal(res.status, 201, `Submit instruction failed: ${String(res.status)}`);
    return (await res.json()) as Record<string, unknown>;
  }

  // ── Core E2E: authenticate → subscribe → stream events ────────────────

  it('receives stream-started, text-delta, stream-completed through WebSocket after instruction submission', async () => {
    // 1. Authenticate via REST
    const auth = await loginViaRest();

    // 2. Open WebSocket with session cookie
    const ws = await connectWebSocket(port, { sessionId: auth.sessionId });
    openSockets.push(ws);

    // 3. Subscribe to conversation
    ws.send(JSON.stringify({ type: 'subscribe', conversationId: CONV_ID }));
    const subMsg = await waitForMessage(ws);
    assert.equal(subMsg['type'], 'subscribed');
    assert.equal(subMsg['conversationId'], CONV_ID);

    // 4. Submit instruction via REST (triggers daemon to produce stream events)
    const turnResult = await submitInstructionViaRest(CONV_ID, 'Hello Hydra', auth);
    assert.ok(turnResult['turn'], 'Expected turn in response');
    assert.ok(turnResult['streamId'], 'Expected streamId in response');
    assert.equal(fakeDaemon.submissions.length, 1);
    assert.equal(fakeDaemon.submissions[0].conversationId, CONV_ID);
    assert.equal(fakeDaemon.submissions[0].instruction, 'Hello Hydra');

    const turnId = fakeDaemon.submissions[0].turnId;

    // 5. Simulate daemon emitting a complete stream
    const emitted = fakeDaemon.emitFullStream(CONV_ID, turnId, ['Hello', ', ', 'world!']);

    // 6. Collect all stream events from WebSocket
    const wsMessages = await waitForMessages(ws, emitted.length);

    // 7. Assert correct event types in order
    assert.equal(wsMessages.length, emitted.length);
    assert.equal((wsMessages[0]['event'] as StreamEvent).kind, 'stream-started');
    assert.equal((lastItem(wsMessages)['event'] as StreamEvent).kind, 'stream-completed');

    const textDeltas = wsMessages.filter((m) => (m['event'] as StreamEvent).kind === 'text-delta');
    assert.equal(textDeltas.length, 3);

    // 8. Verify every WS message wraps the event correctly
    for (const [index, message] of wsMessages.entries()) {
      assert.equal(message['type'], 'stream-event');
      assert.equal(message['conversationId'], CONV_ID);
      assert.deepEqual(message['event'], emitted[index]);
    }
  });

  // ── Sequence number monotonicity ───────────────────────────────────────

  it('delivers stream events with strictly monotonically increasing sequence numbers', async () => {
    const auth = await loginViaRest();
    const ws = await connectWebSocket(port, { sessionId: auth.sessionId });
    openSockets.push(ws);

    ws.send(JSON.stringify({ type: 'subscribe', conversationId: CONV_ID }));
    await waitForMessage(ws); // subscribed

    // Emit a longer stream to make monotonicity check meaningful
    const emitted = fakeDaemon.emitFullStream(CONV_ID, 'turn-mono', ['a', 'b', 'c', 'd', 'e']);

    const wsMessages = await waitForMessages(ws, emitted.length);
    const seqs = wsMessages.map((m) => (m['event'] as StreamEvent).seq);

    // Strictly increasing
    assertMonotonicSequenceNumbers(seqs, 'single stream');
  });

  // ── Multi-conversation isolation ───────────────────────────────────────

  it('delivers events only to the subscribed conversation', async () => {
    const auth = await loginViaRest();
    const ws = await connectWebSocket(port, { sessionId: auth.sessionId });
    openSockets.push(ws);

    // Subscribe to conv-e2e-1 only
    ws.send(JSON.stringify({ type: 'subscribe', conversationId: CONV_ID }));
    await waitForMessage(ws); // subscribed

    // Emit events on conv-e2e-2 (should NOT arrive on this socket)
    bridge.emitStreamEvent('conv-e2e-2', {
      seq: 100,
      turnId: 'turn-other',
      kind: 'text-delta',
      payload: { text: 'should not see this' },
      timestamp: new Date().toISOString(),
    });

    // Emit events on conv-e2e-1 (SHOULD arrive)
    const expected: StreamEvent = {
      seq: 101,
      turnId: 'turn-ours',
      kind: 'text-delta',
      payload: { text: 'visible' },
      timestamp: new Date().toISOString(),
    };
    bridge.emitStreamEvent(CONV_ID, expected);

    const msg = await waitForMessage(ws);
    assert.equal(msg['type'], 'stream-event');
    assert.deepEqual(msg['event'], expected);
  });

  // ── Multiple subscribers ───────────────────────────────────────────────

  it('broadcasts stream events to multiple WebSocket clients subscribed to the same conversation', async () => {
    const auth = await loginViaRest();

    const ws1 = await connectWebSocket(port, { sessionId: auth.sessionId });
    openSockets.push(ws1);
    const ws2 = await connectWebSocket(port, { sessionId: auth.sessionId });
    openSockets.push(ws2);

    // Both subscribe
    ws1.send(JSON.stringify({ type: 'subscribe', conversationId: CONV_ID }));
    ws2.send(JSON.stringify({ type: 'subscribe', conversationId: CONV_ID }));
    await waitForMessage(ws1); // subscribed
    await waitForMessage(ws2); // subscribed

    // Emit a stream event
    const event: StreamEvent = {
      seq: 200,
      turnId: 'turn-broadcast',
      kind: 'text-delta',
      payload: { text: 'shared' },
      timestamp: new Date().toISOString(),
    };
    bridge.emitStreamEvent(CONV_ID, event);

    // Both should receive
    const [msg1, msg2] = await Promise.all([waitForMessage(ws1), waitForMessage(ws2)]);
    assert.deepEqual(msg1['event'], event);
    assert.deepEqual(msg2['event'], event);
  });

  // ── Unsubscribe stops delivery ─────────────────────────────────────────

  it('stops delivering events after unsubscribe', async () => {
    const auth = await loginViaRest();
    const ws = await connectWebSocket(port, { sessionId: auth.sessionId });
    openSockets.push(ws);

    ws.send(JSON.stringify({ type: 'subscribe', conversationId: CONV_ID }));
    await waitForMessage(ws); // subscribed

    ws.send(JSON.stringify({ type: 'unsubscribe', conversationId: CONV_ID }));
    const unsubMsg = await waitForMessage(ws);
    assert.equal(unsubMsg['type'], 'unsubscribed');

    // Emit event after unsubscribe — should NOT be delivered
    bridge.emitStreamEvent(CONV_ID, {
      seq: 300,
      turnId: 'turn-ghost',
      kind: 'text-delta',
      payload: { text: 'invisible' },
      timestamp: new Date().toISOString(),
    });

    // Subscribe to a different conversation to prove the socket is still alive
    ws.send(JSON.stringify({ type: 'subscribe', conversationId: 'conv-e2e-2' }));
    const resubMsg = await waitForMessage(ws);
    assert.equal(resubMsg['type'], 'subscribed');
    assert.equal(resubMsg['conversationId'], 'conv-e2e-2');
  });

  // ── Full lifecycle: login → WS → subscribe → stream → ack ─────────────

  it('full lifecycle: login, connect, subscribe, stream, ack', async () => {
    const auth = await loginViaRest();
    const ws = await connectWebSocket(port, { sessionId: auth.sessionId });
    openSockets.push(ws);

    // Subscribe
    ws.send(JSON.stringify({ type: 'subscribe', conversationId: CONV_ID }));
    const subMsg = await waitForMessage(ws);
    assert.equal(subMsg['type'], 'subscribed');

    // Emit stream
    const emitted = fakeDaemon.emitFullStream(CONV_ID, 'turn-lifecycle', ['chunk']);
    const wsMessages = await waitForMessages(ws, emitted.length);

    // All events received
    assert.equal(wsMessages.length, emitted.length);

    // Client acknowledges the last event
    const lastSeq = (lastItem(wsMessages)['event'] as StreamEvent).seq;
    ws.send(JSON.stringify({ type: 'ack', conversationId: CONV_ID, seq: lastSeq }));

    // Verify ack was recorded on the connection once the async message queue drains
    const connections = gw.connectionRegistry.getByConversation(CONV_ID);
    assert.equal(connections.size, 1);
    const conn = [...connections][0];
    const ackedSeq = await waitFor(
      () => conn.lastAckSeq.get(CONV_ID),
      (seq) => seq === lastSeq,
    );
    assert.equal(ackedSeq, lastSeq);

    ws.close();
    await once(ws, 'close');

    const remainingConnections = await waitFor(
      () => gw.connectionRegistry.getByConversation(CONV_ID).size,
      (size) => size === 0,
    );
    assert.equal(remainingConnections, 0);
  });

  it('returns an error when subscribing to an unknown conversation and keeps the socket usable', async () => {
    const auth = await loginViaRest();
    const ws = await connectWebSocket(port, { sessionId: auth.sessionId });
    openSockets.push(ws);

    ws.send(JSON.stringify({ type: 'subscribe', conversationId: 'conv-missing' }));
    const errorMsg = await waitForMessage(ws);
    assert.equal(errorMsg['type'], 'error');
    assert.equal(errorMsg['code'], 'CONVERSATION_NOT_FOUND');
    assert.equal(errorMsg['conversationId'], 'conv-missing');

    ws.send(JSON.stringify({ type: 'subscribe', conversationId: CONV_ID }));
    const subscribedMsg = await waitForMessage(ws);
    assert.equal(subscribedMsg['type'], 'subscribed');
    assert.equal(subscribedMsg['conversationId'], CONV_ID);
  });

  // ── Sequence monotonicity across multiple turns ────────────────────────

  it('maintains monotonic sequence numbers across multiple turns in the same conversation', async () => {
    const auth = await loginViaRest();
    const ws = await connectWebSocket(port, { sessionId: auth.sessionId });
    openSockets.push(ws);

    ws.send(JSON.stringify({ type: 'subscribe', conversationId: CONV_ID }));
    await waitForMessage(ws); // subscribed

    // First turn
    const events1 = fakeDaemon.emitFullStream(CONV_ID, 'turn-a', ['alpha']);
    // Second turn
    const events2 = fakeDaemon.emitFullStream(CONV_ID, 'turn-b', ['beta', 'gamma']);

    const totalExpected = events1.length + events2.length;
    const wsMessages = await waitForMessages(ws, totalExpected);
    const seqs = wsMessages.map((m) => (m['event'] as StreamEvent).seq);

    // Globally monotonically increasing across both turns
    assertMonotonicSequenceNumbers(seqs, 'multi-turn stream');

    // Verify both turns are represented
    const turnIds = new Set(wsMessages.map((m) => (m['event'] as StreamEvent).turnId));
    assert.ok(turnIds.has('turn-a'));
    assert.ok(turnIds.has('turn-b'));
  });

  // ── Buffer replay on reconnect ─────────────────────────────────────────

  it('replays buffered events on reconnect with lastAcknowledgedSeq', async () => {
    const auth = await loginViaRest();

    // First connection: subscribe + receive events + disconnect
    const ws1 = await connectWebSocket(port, { sessionId: auth.sessionId });
    openSockets.push(ws1);

    ws1.send(JSON.stringify({ type: 'subscribe', conversationId: CONV_ID }));
    await waitForMessage(ws1); // subscribed

    const emitted = fakeDaemon.emitFullStream(CONV_ID, 'turn-replay', ['re', 'play']);
    const firstBatch = await waitForMessages(ws1, emitted.length);
    const firstSeq = (firstBatch[0]['event'] as StreamEvent).seq;
    ws1.close();

    // Second connection: reconnect with lastAcknowledgedSeq pointing before all events
    const ws2 = await connectWebSocket(port, { sessionId: auth.sessionId });
    openSockets.push(ws2);

    ws2.send(
      JSON.stringify({
        type: 'subscribe',
        conversationId: CONV_ID,
        lastAcknowledgedSeq: firstSeq - 1,
      }),
    );

    // Replay sends buffered events first, then the 'subscribed' confirmation
    const replayMsgs = await waitForMessages(ws2, emitted.length + 1);

    // Replayed stream-events arrive before the subscribed message
    const replayedEvents = replayMsgs.slice(0, emitted.length);
    for (const [index, replayedEvent] of replayedEvents.entries()) {
      assert.equal(replayedEvent['type'], 'stream-event');
      assert.deepEqual(replayedEvent['event'], emitted[index]);
    }

    const subscribedMsg = replayMsgs[emitted.length];
    assert.equal(subscribedMsg['type'], 'subscribed');
  });

  // ── Event buffering during active stream ───────────────────────────────

  it('buffers stream events in EventBuffer for later replay', async () => {
    const auth = await loginViaRest();
    const ws = await connectWebSocket(port, { sessionId: auth.sessionId });
    openSockets.push(ws);

    ws.send(JSON.stringify({ type: 'subscribe', conversationId: CONV_ID }));
    await waitForMessage(ws); // subscribed

    const emitted = fakeDaemon.emitFullStream(CONV_ID, 'turn-buf', ['buffered']);
    await waitForMessages(ws, emitted.length);

    // Verify events are in the buffer
    const lastSeq = lastItem(emitted).seq;
    assert.equal(gw.eventBuffer.getHighwaterSeq(CONV_ID), lastSeq);

    // Replay from buffer should return all events
    const replayed = gw.eventBuffer.getEventsSince(CONV_ID, 0);
    assert.equal(replayed.length, emitted.length);
    for (const [index, replayedEvent] of replayed.entries()) {
      assert.deepEqual(replayedEvent, emitted[index]);
    }
  });

  // ── stream-started and stream-completed bookend text-deltas ────────────

  it('stream-started arrives first and stream-completed arrives last in every turn', async () => {
    const auth = await loginViaRest();
    const ws = await connectWebSocket(port, { sessionId: auth.sessionId });
    openSockets.push(ws);

    ws.send(JSON.stringify({ type: 'subscribe', conversationId: CONV_ID }));
    await waitForMessage(ws); // subscribed

    const emitted = fakeDaemon.emitFullStream(CONV_ID, 'turn-bookend', ['a', 'b', 'c']);
    const wsMessages = await waitForMessages(ws, emitted.length);
    const events = wsMessages.map((m) => m['event'] as StreamEvent);

    assert.equal(events[0].kind, 'stream-started');
    assert.equal(lastItem(events).kind, 'stream-completed');

    // All middle events should be text-deltas
    for (const event of events.slice(1, -1)) {
      assert.equal(event.kind, 'text-delta');
    }

    // text-delta payloads should match
    const texts = events
      .filter((e) => e.kind === 'text-delta')
      .map((e) => (e.payload as { text: string }).text);
    assert.deepEqual(texts, ['a', 'b', 'c']);
  });

  // ── T033: End-to-end reconnect/resume ──────────────────────────────────

  describe('T033: End-to-end reconnect/resume', () => {
    it('buffer-hit: full reconnect cycle replays missed events and resumes live streaming', async () => {
      // (a) authenticate
      const auth = await loginViaRest();

      // (b) establish WS + subscribe
      const ws1 = await connectWebSocket(port, { sessionId: auth.sessionId });
      openSockets.push(ws1);
      ws1.send(JSON.stringify({ type: 'subscribe', conversationId: CONV_ID }));
      const sub1 = await waitForMessage(ws1);
      assert.equal(sub1['type'], 'subscribed');

      // (c) receive some events (full turn)
      const turn1 = fakeDaemon.emitFullStream(CONV_ID, 'turn-bh-1', ['alpha', 'beta']);
      const batch1 = await waitForMessages(ws1, turn1.length);
      assert.equal(batch1.length, turn1.length);

      // Record the seq just before the first event for reconnect
      const reconnectFromSeq = turn1[0].seq - 1;

      // (d) disconnect
      ws1.close();
      await once(ws1, 'close');
      await waitFor(
        () => gw.connectionRegistry.getByConversation(CONV_ID).size,
        (size) => size === 0,
      );

      // (e) reconnect with new WS on same session
      const ws2 = await connectWebSocket(port, { sessionId: auth.sessionId });
      openSockets.push(ws2);

      // (f) send subscribe with lastAcknowledgedSeq
      ws2.send(
        JSON.stringify({
          type: 'subscribe',
          conversationId: CONV_ID,
          lastAcknowledgedSeq: reconnectFromSeq,
        }),
      );

      // Assert all missed events replayed in order + subscribed confirmation
      const replayMsgs = await waitForMessages(ws2, turn1.length + 1);
      const replayed = replayMsgs.slice(0, turn1.length);
      for (const [i, msg] of replayed.entries()) {
        assert.equal(msg['type'], 'stream-event');
        assert.deepEqual(msg['event'], turn1[i]);
      }
      assert.equal(replayMsgs[turn1.length]['type'], 'subscribed');

      // (g) live streaming resumes seamlessly
      const turn2 = fakeDaemon.emitFullStream(CONV_ID, 'turn-bh-2', ['gamma']);
      const liveMsgs = await waitForMessages(ws2, turn2.length);
      for (const [i, msg] of liveMsgs.entries()) {
        assert.equal(msg['type'], 'stream-event');
        assert.deepEqual(msg['event'], turn2[i]);
      }

      // SC-003: zero gaps, no duplicates, monotonic across replay + live
      const allSeqs = [
        ...replayed.map((m) => (m['event'] as StreamEvent).seq),
        ...liveMsgs.map((m) => (m['event'] as StreamEvent).seq),
      ];
      assertMonotonicSequenceNumbers(allSeqs, 'buffer-hit reconnect: replay + live');

      // Verify contiguity (no gaps)
      for (let i = 1; i < allSeqs.length; i++) {
        assert.equal(
          allSeqs[i],
          allSeqs[i - 1] + 1,
          `Gap detected between seq ${String(allSeqs[i - 1])} and ${String(allSeqs[i])}`,
        );
      }
    });

    it('daemon-fallback: replays via daemon when buffer cannot satisfy and resumes live streaming', async () => {
      // (a) authenticate
      const auth = await loginViaRest();

      // (b) establish WS + subscribe + receive turn 1 events
      const ws1 = await connectWebSocket(port, { sessionId: auth.sessionId });
      openSockets.push(ws1);
      ws1.send(JSON.stringify({ type: 'subscribe', conversationId: CONV_ID }));
      await waitForMessage(ws1); // subscribed

      const turn1 = fakeDaemon.emitFullStream(CONV_ID, 'turn-df-1', ['one', 'two']);
      await waitForMessages(ws1, turn1.length);
      const lastTurn1Seq = lastItem(turn1).seq;

      // (c) disconnect
      ws1.close();
      await once(ws1, 'close');
      await waitFor(
        () => gw.connectionRegistry.getByConversation(CONV_ID).size,
        (s) => s === 0,
      );

      // Simulate buffer loss (e.g. server restart or buffer overflow)
      gw.eventBuffer.evictConversation(CONV_ID);

      // Build turn 2 events that the daemon will return during fallback replay
      const turn2Events: StreamEvent[] = [
        {
          seq: lastTurn1Seq + 1,
          turnId: 'turn-df-2',
          kind: 'stream-started',
          payload: { streamId: 'stream-df-2' },
          timestamp: new Date().toISOString(),
        },
        {
          seq: lastTurn1Seq + 2,
          turnId: 'turn-df-2',
          kind: 'text-delta',
          payload: { text: 'three' },
          timestamp: new Date().toISOString(),
        },
        {
          seq: lastTurn1Seq + 3,
          turnId: 'turn-df-2',
          kind: 'text-delta',
          payload: { text: 'four' },
          timestamp: new Date().toISOString(),
        },
        {
          seq: lastTurn1Seq + 4,
          turnId: 'turn-df-2',
          kind: 'stream-completed',
          payload: { responseLength: 9 },
          timestamp: new Date().toISOString(),
        },
      ];

      // Configure wsDaemonClient for daemon-fallback replay
      fakeDaemon.wsDaemonClient.openConversation = async (convId: string) => {
        if (convId === CONV_ID) {
          return {
            data: {
              conversation: {
                id: CONV_ID,
                status: 'active' as const,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                turnCount: 2,
                pendingInstructionCount: 0,
              },
              recentTurns: [],
              totalTurnCount: 2,
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
      };

      fakeDaemon.wsDaemonClient.loadTurnHistory = async () => ({
        data: {
          turns: [
            {
              id: 'turn-df-1',
              conversationId: CONV_ID,
              position: 1,
              kind: 'operator' as const,
              attribution: { type: 'operator' as const, label: 'admin' },
              instruction: 'test',
              status: 'completed' as const,
              createdAt: new Date().toISOString(),
            },
            {
              id: 'turn-df-2',
              conversationId: CONV_ID,
              position: 2,
              kind: 'operator' as const,
              attribution: { type: 'operator' as const, label: 'admin' },
              instruction: 'test2',
              status: 'completed' as const,
              createdAt: new Date().toISOString(),
            },
          ],
          totalCount: 2,
          hasMore: false,
        },
      });

      fakeDaemon.wsDaemonClient.getStreamReplay = async (
        _convId: string,
        turnId: string,
        lastAckSeq: number,
      ) => {
        // Turn 1 events: all have seq <= lastTurn1Seq = lastAckSeq, so empty after filter
        if (turnId === 'turn-df-1') {
          return { data: { events: turn1.filter((e) => e.seq > lastAckSeq) } };
        }
        // Turn 2 events: all have seq > lastTurn1Seq
        if (turnId === 'turn-df-2') {
          return { data: { events: turn2Events.filter((e) => e.seq > lastAckSeq) } };
        }
        return { data: { events: [] } };
      };

      // (d) reconnect with new WS on same session
      const ws2 = await connectWebSocket(port, { sessionId: auth.sessionId });
      openSockets.push(ws2);

      // (e) send subscribe with lastAcknowledgedSeq
      ws2.send(
        JSON.stringify({
          type: 'subscribe',
          conversationId: CONV_ID,
          lastAcknowledgedSeq: lastTurn1Seq,
        }),
      );

      // (f) assert all missed events replayed in order (turn 2 events only)
      const replayMsgs = await waitForMessages(ws2, turn2Events.length + 1);
      const replayed = replayMsgs.slice(0, turn2Events.length);
      for (const [i, msg] of replayed.entries()) {
        assert.equal(msg['type'], 'stream-event');
        assert.deepEqual(msg['event'], turn2Events[i]);
      }
      assert.equal(replayMsgs[turn2Events.length]['type'], 'subscribed');

      // (g) live streaming resumes seamlessly — emit with correct seq continuation
      const liveStartSeq = lastTurn1Seq + turn2Events.length + 1;
      const turn3Events: StreamEvent[] = [
        {
          seq: liveStartSeq,
          turnId: 'turn-df-3',
          kind: 'stream-started',
          payload: { streamId: 'stream-df-3' },
          timestamp: new Date().toISOString(),
        },
        {
          seq: liveStartSeq + 1,
          turnId: 'turn-df-3',
          kind: 'text-delta',
          payload: { text: 'live-after-daemon' },
          timestamp: new Date().toISOString(),
        },
        {
          seq: liveStartSeq + 2,
          turnId: 'turn-df-3',
          kind: 'stream-completed',
          payload: { responseLength: 17 },
          timestamp: new Date().toISOString(),
        },
      ];
      for (const event of turn3Events) {
        bridge.emitStreamEvent(CONV_ID, event);
      }
      const liveMsgs = await waitForMessages(ws2, turn3Events.length);
      for (const [i, msg] of liveMsgs.entries()) {
        assert.equal(msg['type'], 'stream-event');
        assert.deepEqual(msg['event'], turn3Events[i]);
      }

      // SC-003: monotonic + no gaps across replay + live
      const allSeqs = [
        ...replayed.map((m) => (m['event'] as StreamEvent).seq),
        ...liveMsgs.map((m) => (m['event'] as StreamEvent).seq),
      ];
      assertMonotonicSequenceNumbers(allSeqs, 'daemon-fallback: replay + live');
      for (let i = 1; i < allSeqs.length; i++) {
        assert.equal(
          allSeqs[i],
          allSeqs[i - 1] + 1,
          `Gap in daemon-fallback replay+live at seq ${String(allSeqs[i - 1])} → ${String(allSeqs[i])}`,
        );
      }
    });

    it('zero gaps and no duplicates across replay-to-live transition (SC-003)', async () => {
      const auth = await loginViaRest();

      // Subscribe and receive two turns of events
      const ws1 = await connectWebSocket(port, { sessionId: auth.sessionId });
      openSockets.push(ws1);
      ws1.send(JSON.stringify({ type: 'subscribe', conversationId: CONV_ID }));
      await waitForMessage(ws1); // subscribed

      const t1 = fakeDaemon.emitFullStream(CONV_ID, 'turn-gap-1', ['a', 'b']);
      const t2 = fakeDaemon.emitFullStream(CONV_ID, 'turn-gap-2', ['c', 'd']);
      const allEmitted = [...t1, ...t2];
      await waitForMessages(ws1, allEmitted.length);

      const beforeAllSeq = t1[0].seq - 1;

      // Disconnect
      ws1.close();
      await once(ws1, 'close');
      await waitFor(
        () => gw.connectionRegistry.getByConversation(CONV_ID).size,
        (s) => s === 0,
      );

      // Reconnect — buffer-hit replay of all events
      const ws2 = await connectWebSocket(port, { sessionId: auth.sessionId });
      openSockets.push(ws2);
      ws2.send(
        JSON.stringify({
          type: 'subscribe',
          conversationId: CONV_ID,
          lastAcknowledgedSeq: beforeAllSeq,
        }),
      );

      const replayMsgs = await waitForMessages(ws2, allEmitted.length + 1);
      assert.equal(replayMsgs[allEmitted.length]['type'], 'subscribed');

      // Immediately emit a 3rd turn (live events)
      const t3 = fakeDaemon.emitFullStream(CONV_ID, 'turn-gap-3', ['e']);
      const liveMsgs = await waitForMessages(ws2, t3.length);

      // Collect all sequence numbers (replay + live)
      const replaySeqs = replayMsgs
        .slice(0, allEmitted.length)
        .map((m) => (m['event'] as StreamEvent).seq);
      const liveSeqs = liveMsgs.map((m) => (m['event'] as StreamEvent).seq);
      const allSeqs = [...replaySeqs, ...liveSeqs];

      // Verify zero gaps: each consecutive seq differs by exactly 1
      for (let i = 1; i < allSeqs.length; i++) {
        assert.equal(
          allSeqs[i],
          allSeqs[i - 1] + 1,
          `Gap at index ${String(i)}: expected ${String(allSeqs[i - 1] + 1)}, got ${String(allSeqs[i])}`,
        );
      }

      // No duplicates: all seqs unique
      assert.equal(new Set(allSeqs).size, allSeqs.length, 'Duplicate sequence numbers detected');

      // Strictly monotonic
      assertMonotonicSequenceNumbers(allSeqs, 'zero-gaps replay→live');
    });
  });
});
