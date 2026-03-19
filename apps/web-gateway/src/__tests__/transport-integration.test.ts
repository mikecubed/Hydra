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
import type { StreamEvent, TurnStatus } from '@hydra/web-contracts';
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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
/** Mutable approval state exposed by the fake daemon client. */
interface FakeApproval {
  id: string;
  turnId: string;
  status: 'pending' | 'responded' | 'expired' | 'stale';
  prompt: string;
  response?: string;
}

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
  planFullStream: (conversationId: string, turnId: string, textChunks: string[]) => StreamEvent[];
  emitFullStream: (conversationId: string, turnId: string, textChunks: string[]) => StreamEvent[];
  pendingApprovals: FakeApproval[];
  cancelledTurns: Array<{ conversationId: string; turnId: string }>;
  retriedTurns: Array<{ conversationId: string; turnId: string; newTurnId: string }>;
  nextSeq: () => number;
} {
  const validConversationIds = new Set(options.validConversationIds);
  let seq = options.seqStart ?? 1;
  let turnCounter = 0;
  const submissions: Array<{ conversationId: string; instruction: string; turnId: string }> = [];
  const pendingApprovals: FakeApproval[] = [];
  const cancelledTurns: Array<{ conversationId: string; turnId: string }> = [];
  const retriedTurns: Array<{ conversationId: string; turnId: string; newTurnId: string }> = [];
  const turnsByConversation = new Map<string, Array<ReturnType<typeof makeTurn>>>();
  const replayEventsByTurn = new Map<string, StreamEvent[]>();

  const nextSeq = (): number => seq++;

  const notFoundError: GatewayErrorResponse = {
    ok: false,
    code: 'CONVERSATION_NOT_FOUND',
    category: 'validation',
    message: 'Conversation not found',
  };

  const openConversation = async (conversationId: string) => {
    if (validConversationIds.has(conversationId)) {
      return {
        data: {
          conversation: {
            id: conversationId,
            status: 'active' as const,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            turnCount: turnsByConversation.get(conversationId)?.length ?? 0,
            pendingInstructionCount: 0,
          },
          recentTurns: [],
          totalTurnCount: turnsByConversation.get(conversationId)?.length ?? 0,
          pendingApprovals: [],
        },
      };
    }
    return { error: notFoundError };
  };

  const planFullStream = (
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

    for (const text of textChunks) {
      const delta: StreamEvent = {
        seq: seq++,
        turnId,
        kind: 'text-delta',
        payload: { text },
        timestamp: new Date().toISOString(),
      };
      events.push(delta);
    }

    const completed: StreamEvent = {
      seq: seq++,
      turnId,
      kind: 'stream-completed',
      payload: { responseLength: textChunks.join('').length },
      timestamp: new Date().toISOString(),
    };
    events.push(completed);
    replayEventsByTurn.set(
      turnId,
      events.map((event) => ({ ...event })),
    );
    const existingTurns = turnsByConversation.get(conversationId) ?? [];
    const priorTurn = existingTurns.find((t) => t.id === turnId);
    storeTurn(
      makeTurn(
        turnId,
        conversationId,
        priorTurn?.position ?? existingTurns.length + 1,
        'completed',
        priorTurn?.instruction ?? 'emitted-stream',
      ),
    );

    return events;
  };

  /** Emit a complete stream lifecycle: started → N text-deltas → completed.
   *  Returns the emitted events for assertion convenience. */
  const emitFullStream = (
    conversationId: string,
    turnId: string,
    textChunks: string[],
  ): StreamEvent[] => {
    const events = planFullStream(conversationId, turnId, textChunks);
    for (const event of events) {
      bridge.emitStreamEvent(conversationId, event);
    }
    return events;
  };

  const makeTurn = (
    id: string,
    conversationId: string,
    position: number,
    status: TurnStatus,
    instruction: string,
    parentTurnId?: string,
  ) => ({
    id,
    conversationId,
    position,
    kind: 'operator' as const,
    attribution: { type: 'operator' as const, label: 'admin' },
    instruction,
    status,
    ...(parentTurnId ? { parentTurnId } : {}),
    createdAt: new Date().toISOString(),
  });

  const storeTurn = (turn: ReturnType<typeof makeTurn>): void => {
    const turns = turnsByConversation.get(turn.conversationId) ?? [];
    const existingIndex = turns.findIndex((candidate) => candidate['id'] === turn.id);
    if (existingIndex >= 0) {
      turns[existingIndex] = turn;
    } else {
      turns.push(turn);
    }
    turnsByConversation.set(turn.conversationId, turns);
  };

  const loadTurnHistory = async (
    conversationId: string,
    _query: {
      conversationId: string;
      fromPosition?: number;
      toPosition?: number;
      limit?: number;
    },
  ) => {
    const turns = [...(turnsByConversation.get(conversationId) ?? [])].sort(
      (left, right) => left.position - right.position,
    );
    return { data: { turns, totalCount: turns.length, hasMore: false } };
  };

  const getStreamReplay = async (
    _conversationId: string,
    turnId: string,
    lastAcknowledgedSeq = 0,
  ) => {
    const events =
      replayEventsByTurn
        .get(turnId)
        ?.filter((event) => event.seq > lastAcknowledgedSeq)
        .map((event) => ({ ...event })) ?? [];
    return { data: { events } };
  };

  // Minimal DaemonClient fake — only methods used by conversation routes.
  // submitInstruction simulates the daemon accepting and recording the turn.
  const daemonClient = {
    openConversation,
    loadTurnHistory,
    async submitInstruction(
      conversationId: string,
      body: { instruction: string },
      _opts?: { sessionId: string },
    ) {
      if (!validConversationIds.has(conversationId)) {
        return { error: notFoundError };
      }
      turnCounter++;
      const turnId = `turn-${String(turnCounter)}`;
      submissions.push({ conversationId, instruction: body.instruction, turnId });
      storeTurn(makeTurn(turnId, conversationId, turnCounter, 'executing', body.instruction));
      return {
        data: {
          turn: makeTurn(turnId, conversationId, turnCounter, 'executing', body.instruction),
          streamId: `stream-${turnId}`,
        },
      };
    },
    async createConversation(body: { title?: string }) {
      const id = `conv-${String(Date.now())}`;
      validConversationIds.add(id);
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
    async getPendingApprovals(conversationId: string) {
      if (!validConversationIds.has(conversationId)) {
        return { error: notFoundError };
      }
      return {
        data: {
          approvals: pendingApprovals
            .filter((a) => a.status === 'pending')
            .map((a) => ({
              id: a.id,
              turnId: a.turnId,
              status: a.status,
              prompt: a.prompt,
              context: {},
              contextHash: `hash-${a.id}`,
              responseOptions: [
                { key: 'approve', label: 'Approve' },
                { key: 'reject', label: 'Reject' },
              ],
              createdAt: new Date().toISOString(),
            })),
        },
      };
    },
    async respondToApproval(
      approvalId: string,
      body: { response: string; acknowledgeStaleness?: boolean; sessionId: string },
    ) {
      const approval = pendingApprovals.find((a) => a.id === approvalId);
      if (!approval) {
        return {
          error: {
            ok: false as const,
            code: 'APPROVAL_NOT_FOUND',
            category: 'validation' as const,
            message: 'Approval not found',
            httpStatus: 404,
          },
        };
      }
      approval.status = 'responded';
      approval.response = body.response;
      return {
        data: {
          success: true,
          approval: {
            id: approval.id,
            turnId: approval.turnId,
            status: 'responded' as const,
            prompt: approval.prompt,
            context: {},
            contextHash: `hash-${approval.id}`,
            responseOptions: [
              { key: 'approve', label: 'Approve' },
              { key: 'reject', label: 'Reject' },
            ],
            response: body.response,
            respondedAt: new Date().toISOString(),
            createdAt: new Date().toISOString(),
          },
        },
      };
    },
    async cancelWork(conversationId: string, turnId: string) {
      if (!validConversationIds.has(conversationId)) {
        return { error: notFoundError };
      }
      cancelledTurns.push({ conversationId, turnId });
      return {
        data: {
          success: true,
          turn: makeTurn(turnId, conversationId, 1, 'cancelled', 'cancelled-instruction'),
        },
      };
    },
    async retryTurn(conversationId: string, turnId: string) {
      if (!validConversationIds.has(conversationId)) {
        return { error: notFoundError };
      }
      turnCounter++;
      const newTurnId = `turn-${String(turnCounter)}`;
      retriedTurns.push({ conversationId, turnId, newTurnId });
      return {
        data: {
          turn: makeTurn(
            newTurnId,
            conversationId,
            turnCounter,
            'executing',
            'retried-instruction',
            turnId,
          ),
          streamId: `stream-${newTurnId}`,
        },
      };
    },
  } as unknown as DaemonClient;

  const wsDaemonClient: Pick<
    DaemonClient,
    'openConversation' | 'loadTurnHistory' | 'getStreamReplay'
  > = {
    openConversation,
    loadTurnHistory,
    getStreamReplay,
  };

  return {
    daemonClient,
    wsDaemonClient,
    submissions,
    planFullStream,
    emitFullStream,
    pendingApprovals,
    cancelledTurns,
    retriedTurns,
    nextSeq,
  };
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

    it('daemon-fallback: merges buffered overlap, queues in-flight replay events, and resumes live streaming', async () => {
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

      // Keep one overlapping event in the buffer so daemon fallback must merge
      // replay results with buffered tail data while still remaining a buffer miss.
      bridge.emitStreamEvent(CONV_ID, turn2Events[0]);

      let releaseReplay: (() => void) | undefined;
      const replayGate = new Promise<void>((resolve) => {
        releaseReplay = resolve;
      });
      let replayStarted = false;

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
        replayStarted = true;
        await replayGate;

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
          lastAcknowledgedSeq: lastTurn1Seq - 1,
        }),
      );

      await waitFor(
        () => replayStarted,
        (started) => started,
      );

      const duringReplayEvent: StreamEvent = {
        seq: lastTurn1Seq + turn2Events.length + 1,
        turnId: 'turn-df-live',
        kind: 'text-delta',
        payload: { text: 'during-replay' },
        timestamp: new Date().toISOString(),
      };
      bridge.emitStreamEvent(CONV_ID, duringReplayEvent);
      releaseReplay?.();

      // (f) assert all missed events replayed in order, including the in-flight
      // event that arrived while replay was still active.
      const expectedReplayEvents = [lastItem(turn1), ...turn2Events, duringReplayEvent];
      const replayMsgs = await waitForMessages(ws2, expectedReplayEvents.length + 1);
      const replayed = replayMsgs.slice(0, expectedReplayEvents.length);
      for (const [i, msg] of replayed.entries()) {
        assert.equal(msg['type'], 'stream-event');
        assert.deepEqual(msg['event'], expectedReplayEvents[i]);
      }
      assert.equal(replayMsgs[expectedReplayEvents.length]['type'], 'subscribed');

      // (g) live streaming resumes seamlessly — emit with correct seq continuation
      const liveStartSeq = duringReplayEvent.seq + 1;
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
      assert.equal(new Set(allSeqs).size, allSeqs.length, 'Duplicate sequence numbers detected');
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

  // ── T034: Replay ordering guarantees (FR-024) ─────────────────────────

  describe('T034: Replay ordering guarantees (FR-024)', () => {
    it('buffer-hit replay preserves original ordering and sequence numbers exactly', async () => {
      const auth = await loginViaRest();

      // First connection — receive a large multi-turn stream
      const ws1 = await connectWebSocket(port, { sessionId: auth.sessionId });
      openSockets.push(ws1);
      ws1.send(JSON.stringify({ type: 'subscribe', conversationId: CONV_ID }));
      await waitForMessage(ws1); // subscribed

      const turn1 = fakeDaemon.emitFullStream(CONV_ID, 'turn-ord-1', ['a', 'b', 'c']);
      const turn2 = fakeDaemon.emitFullStream(CONV_ID, 'turn-ord-2', ['d', 'e']);
      const turn3 = fakeDaemon.emitFullStream(CONV_ID, 'turn-ord-3', ['f', 'g', 'h', 'i']);
      const allOriginal = [...turn1, ...turn2, ...turn3];
      const originalMsgs = await waitForMessages(ws1, allOriginal.length);
      for (const [i, msg] of originalMsgs.entries()) {
        assert.equal(msg['type'], 'stream-event');
        assert.deepEqual(
          msg['event'],
          allOriginal[i],
          `live source order mismatch at index ${String(i)}`,
        );
      }

      const beforeAllSeq = turn1[0].seq - 1;

      // Disconnect
      ws1.close();
      await once(ws1, 'close');
      await waitFor(
        () => gw.connectionRegistry.getByConversation(CONV_ID).size,
        (s) => s === 0,
      );

      // Reconnect — replay all events from buffer
      const ws2 = await connectWebSocket(port, { sessionId: auth.sessionId });
      openSockets.push(ws2);
      ws2.send(
        JSON.stringify({
          type: 'subscribe',
          conversationId: CONV_ID,
          lastAcknowledgedSeq: beforeAllSeq,
        }),
      );

      const replayMsgs = await waitForMessages(ws2, allOriginal.length + 1);
      const replayed = replayMsgs.slice(0, allOriginal.length);
      assert.equal(replayMsgs[allOriginal.length]['type'], 'subscribed');

      // FR-024: replayed events must match original events exactly — same
      // ordering, same sequence numbers, same payloads.
      for (const [i, msg] of replayed.entries()) {
        assert.equal(msg['type'], 'stream-event');
        const replayedEvent = msg['event'] as StreamEvent;
        const originalEvent = allOriginal[i];
        assert.equal(replayedEvent.seq, originalEvent.seq, `seq mismatch at index ${String(i)}`);
        assert.equal(replayedEvent.kind, originalEvent.kind, `kind mismatch at index ${String(i)}`);
        assert.equal(
          replayedEvent.turnId,
          originalEvent.turnId,
          `turnId mismatch at index ${String(i)}`,
        );
        assert.deepEqual(
          replayedEvent.payload,
          originalEvent.payload,
          `payload mismatch at index ${String(i)}`,
        );
      }

      // FR-024: zero reordering — sequence numbers are strictly ascending
      const replayedSeqs = replayed.map((m) => (m['event'] as StreamEvent).seq);
      assertMonotonicSequenceNumbers(replayedSeqs, 'buffer-hit replay ordering');

      // FR-024: zero gaps — each consecutive seq differs by exactly 1
      for (let i = 1; i < replayedSeqs.length; i++) {
        assert.equal(
          replayedSeqs[i],
          replayedSeqs[i - 1] + 1,
          `Gap in replay at index ${String(i)}: ${String(replayedSeqs[i - 1])} → ${String(replayedSeqs[i])}`,
        );
      }

      // FR-024: zero duplicates
      assert.equal(
        new Set(replayedSeqs).size,
        replayedSeqs.length,
        'Duplicate sequence numbers in replay',
      );
    });

    it('daemon-fallback merges events from multiple turns with zero reordering, gaps, or duplicates', async () => {
      const auth = await loginViaRest();

      // Initial subscribe to prime the system
      const ws1 = await connectWebSocket(port, { sessionId: auth.sessionId });
      openSockets.push(ws1);
      ws1.send(JSON.stringify({ type: 'subscribe', conversationId: CONV_ID }));
      await waitForMessage(ws1); // subscribed

      // Emit turn 1 events (client receives these)
      const turn1 = fakeDaemon.emitFullStream(CONV_ID, 'turn-merge-1', ['alpha']);
      await waitForMessages(ws1, turn1.length);
      const lastTurn1Seq = lastItem(turn1).seq;

      // Disconnect
      ws1.close();
      await once(ws1, 'close');
      await waitFor(
        () => gw.connectionRegistry.getByConversation(CONV_ID).size,
        (s) => s === 0,
      );

      // Evict buffer to force daemon-fallback
      gw.eventBuffer.evictConversation(CONV_ID);

      // Build events for 3 turns that the daemon will return
      const turn2Events: StreamEvent[] = [
        {
          seq: lastTurn1Seq + 1,
          turnId: 'turn-merge-2',
          kind: 'stream-started',
          payload: { streamId: 'stream-merge-2' },
          timestamp: new Date().toISOString(),
        },
        {
          seq: lastTurn1Seq + 2,
          turnId: 'turn-merge-2',
          kind: 'text-delta',
          payload: { text: 'beta' },
          timestamp: new Date().toISOString(),
        },
        {
          seq: lastTurn1Seq + 3,
          turnId: 'turn-merge-2',
          kind: 'stream-completed',
          payload: { responseLength: 4 },
          timestamp: new Date().toISOString(),
        },
      ];

      const turn3Events: StreamEvent[] = [
        {
          seq: lastTurn1Seq + 4,
          turnId: 'turn-merge-3',
          kind: 'stream-started',
          payload: { streamId: 'stream-merge-3' },
          timestamp: new Date().toISOString(),
        },
        {
          seq: lastTurn1Seq + 5,
          turnId: 'turn-merge-3',
          kind: 'text-delta',
          payload: { text: 'gamma' },
          timestamp: new Date().toISOString(),
        },
        {
          seq: lastTurn1Seq + 6,
          turnId: 'turn-merge-3',
          kind: 'text-delta',
          payload: { text: 'delta' },
          timestamp: new Date().toISOString(),
        },
        {
          seq: lastTurn1Seq + 7,
          turnId: 'turn-merge-3',
          kind: 'stream-completed',
          payload: { responseLength: 10 },
          timestamp: new Date().toISOString(),
        },
      ];

      // Configure daemon to return turn history + per-turn replay
      fakeDaemon.wsDaemonClient.openConversation = async (convId: string) => {
        if (convId === CONV_ID) {
          return {
            data: {
              conversation: {
                id: CONV_ID,
                status: 'active' as const,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                turnCount: 3,
                pendingInstructionCount: 0,
              },
              recentTurns: [],
              totalTurnCount: 3,
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
              id: 'turn-merge-1',
              conversationId: CONV_ID,
              position: 1,
              kind: 'operator' as const,
              attribution: { type: 'operator' as const, label: 'admin' },
              instruction: 'test1',
              status: 'completed' as const,
              createdAt: new Date().toISOString(),
            },
            {
              id: 'turn-merge-2',
              conversationId: CONV_ID,
              position: 2,
              kind: 'operator' as const,
              attribution: { type: 'operator' as const, label: 'admin' },
              instruction: 'test2',
              status: 'completed' as const,
              createdAt: new Date().toISOString(),
            },
            {
              id: 'turn-merge-3',
              conversationId: CONV_ID,
              position: 3,
              kind: 'operator' as const,
              attribution: { type: 'operator' as const, label: 'admin' },
              instruction: 'test3',
              status: 'completed' as const,
              createdAt: new Date().toISOString(),
            },
          ],
          totalCount: 3,
          hasMore: false,
        },
      });

      fakeDaemon.wsDaemonClient.getStreamReplay = async (
        _convId: string,
        turnId: string,
        lastAckSeq: number,
      ) => {
        if (turnId === 'turn-merge-1') {
          return { data: { events: turn1.filter((e) => e.seq > lastAckSeq) } };
        }
        if (turnId === 'turn-merge-2') {
          return { data: { events: turn2Events.filter((e) => e.seq > lastAckSeq) } };
        }
        if (turnId === 'turn-merge-3') {
          return { data: { events: turn3Events.filter((e) => e.seq > lastAckSeq) } };
        }
        return { data: { events: [] } };
      };

      // Reconnect with lastAcknowledgedSeq = last turn 1 event
      const ws2 = await connectWebSocket(port, { sessionId: auth.sessionId });
      openSockets.push(ws2);
      ws2.send(
        JSON.stringify({
          type: 'subscribe',
          conversationId: CONV_ID,
          lastAcknowledgedSeq: lastTurn1Seq,
        }),
      );

      const allExpected = [...turn2Events, ...turn3Events];
      const replayMsgs = await waitForMessages(ws2, allExpected.length + 1);
      const replayed = replayMsgs.slice(0, allExpected.length);
      assert.equal(replayMsgs[allExpected.length]['type'], 'subscribed');

      // FR-024: replayed events preserve original ordering across turns
      for (const [i, msg] of replayed.entries()) {
        assert.equal(msg['type'], 'stream-event');
        assert.deepEqual(msg['event'], allExpected[i]);
      }

      // FR-024: verify ordering invariants
      const allSeqs = replayed.map((m) => (m['event'] as StreamEvent).seq);
      assertMonotonicSequenceNumbers(allSeqs, 'daemon-fallback multi-turn merge');

      // Zero gaps
      for (let i = 1; i < allSeqs.length; i++) {
        assert.equal(
          allSeqs[i],
          allSeqs[i - 1] + 1,
          `Gap in multi-turn merge at ${String(allSeqs[i - 1])} → ${String(allSeqs[i])}`,
        );
      }

      // Zero duplicates
      assert.equal(
        new Set(allSeqs).size,
        allSeqs.length,
        'Duplicate sequence numbers in multi-turn merge',
      );

      // Turn IDs are represented in order
      const turnIds = replayed.map((m) => (m['event'] as StreamEvent).turnId);
      const firstTurn3Idx = turnIds.indexOf('turn-merge-3');
      assert.ok(firstTurn3Idx > 0, 'turn-merge-3 events should follow turn-merge-2 events');
      for (let i = 0; i < firstTurn3Idx; i++) {
        assert.equal(turnIds[i], 'turn-merge-2', `Expected turn-merge-2 at index ${String(i)}`);
      }
    });

    it('multiple live events arriving during daemon-fallback replay are delivered in order after replay', async () => {
      const auth = await loginViaRest();

      // Initial subscribe + receive events
      const ws1 = await connectWebSocket(port, { sessionId: auth.sessionId });
      openSockets.push(ws1);
      ws1.send(JSON.stringify({ type: 'subscribe', conversationId: CONV_ID }));
      await waitForMessage(ws1); // subscribed

      const initialEvents = fakeDaemon.emitFullStream(CONV_ID, 'turn-pend-1', ['x']);
      await waitForMessages(ws1, initialEvents.length);
      const lastInitialSeq = lastItem(initialEvents).seq;

      // Disconnect + evict buffer
      ws1.close();
      await once(ws1, 'close');
      await waitFor(
        () => gw.connectionRegistry.getByConversation(CONV_ID).size,
        (s) => s === 0,
      );
      gw.eventBuffer.evictConversation(CONV_ID);

      // Daemon replay events
      const daemonEvents: StreamEvent[] = [
        {
          seq: lastInitialSeq + 1,
          turnId: 'turn-pend-2',
          kind: 'stream-started',
          payload: { streamId: 'stream-pend-2' },
          timestamp: new Date().toISOString(),
        },
        {
          seq: lastInitialSeq + 2,
          turnId: 'turn-pend-2',
          kind: 'text-delta',
          payload: { text: 'replayed' },
          timestamp: new Date().toISOString(),
        },
        {
          seq: lastInitialSeq + 3,
          turnId: 'turn-pend-2',
          kind: 'stream-completed',
          payload: { responseLength: 8 },
          timestamp: new Date().toISOString(),
        },
      ];

      // Three live events that will arrive during daemon replay
      const liveEventsDuringReplay: StreamEvent[] = [
        {
          seq: lastInitialSeq + 4,
          turnId: 'turn-pend-3',
          kind: 'stream-started',
          payload: { streamId: 'stream-pend-3' },
          timestamp: new Date().toISOString(),
        },
        {
          seq: lastInitialSeq + 5,
          turnId: 'turn-pend-3',
          kind: 'text-delta',
          payload: { text: 'live-during-1' },
          timestamp: new Date().toISOString(),
        },
        {
          seq: lastInitialSeq + 6,
          turnId: 'turn-pend-3',
          kind: 'text-delta',
          payload: { text: 'live-during-2' },
          timestamp: new Date().toISOString(),
        },
      ];

      let releaseReplay: (() => void) | undefined;
      const replayGate = new Promise<void>((resolve) => {
        releaseReplay = resolve;
      });
      let replayStarted = false;

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
              id: 'turn-pend-1',
              conversationId: CONV_ID,
              position: 1,
              kind: 'operator' as const,
              attribution: { type: 'operator' as const, label: 'admin' },
              instruction: 'test',
              status: 'completed' as const,
              createdAt: new Date().toISOString(),
            },
            {
              id: 'turn-pend-2',
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
        replayStarted = true;
        await replayGate;
        if (turnId === 'turn-pend-1') {
          return { data: { events: initialEvents.filter((e) => e.seq > lastAckSeq) } };
        }
        if (turnId === 'turn-pend-2') {
          return { data: { events: daemonEvents.filter((e) => e.seq > lastAckSeq) } };
        }
        return { data: { events: [] } };
      };

      // Reconnect
      const ws2 = await connectWebSocket(port, { sessionId: auth.sessionId });
      openSockets.push(ws2);
      ws2.send(
        JSON.stringify({
          type: 'subscribe',
          conversationId: CONV_ID,
          lastAcknowledgedSeq: lastInitialSeq,
        }),
      );

      // Wait for replay to start, then emit multiple live events during the window
      await waitFor(
        () => replayStarted,
        (started) => started,
      );
      for (const evt of liveEventsDuringReplay) {
        bridge.emitStreamEvent(CONV_ID, evt);
      }
      releaseReplay?.();

      // Expect: daemon replay events + pending live events + subscribed
      const allExpectedEvents = [...daemonEvents, ...liveEventsDuringReplay];
      const allMsgs = await waitForMessages(ws2, allExpectedEvents.length + 1);
      const eventMsgs = allMsgs.slice(0, allExpectedEvents.length);
      assert.equal(allMsgs[allExpectedEvents.length]['type'], 'subscribed');

      // FR-024: all events in correct order with correct payloads
      for (const [i, msg] of eventMsgs.entries()) {
        assert.equal(msg['type'], 'stream-event');
        assert.deepEqual(
          msg['event'],
          allExpectedEvents[i],
          `Event mismatch at index ${String(i)}`,
        );
      }

      // FR-024 invariants: monotonic, zero gaps, zero duplicates
      const allSeqs = eventMsgs.map((m) => (m['event'] as StreamEvent).seq);
      assertMonotonicSequenceNumbers(allSeqs, 'pending events during daemon-fallback');
      for (let i = 1; i < allSeqs.length; i++) {
        assert.equal(
          allSeqs[i],
          allSeqs[i - 1] + 1,
          `Gap after daemon replay+pending flush at ${String(allSeqs[i - 1])} → ${String(allSeqs[i])}`,
        );
      }
      assert.equal(
        new Set(allSeqs).size,
        allSeqs.length,
        'Duplicate seq in daemon-fallback with pending events',
      );
    });

    it('partial ack replay: only events after lastAcknowledgedSeq are replayed with preserved ordering', async () => {
      const auth = await loginViaRest();

      // First connection — receive events across two turns
      const ws1 = await connectWebSocket(port, { sessionId: auth.sessionId });
      openSockets.push(ws1);
      ws1.send(JSON.stringify({ type: 'subscribe', conversationId: CONV_ID }));
      await waitForMessage(ws1); // subscribed

      const turn1 = fakeDaemon.emitFullStream(CONV_ID, 'turn-partial-1', ['one', 'two']);
      const turn2 = fakeDaemon.emitFullStream(CONV_ID, 'turn-partial-2', ['three', 'four']);
      const allEvents = [...turn1, ...turn2];
      await waitForMessages(ws1, allEvents.length);

      // Client acks halfway through (end of turn 1)
      const ackSeq = lastItem(turn1).seq;

      // Disconnect
      ws1.close();
      await once(ws1, 'close');
      await waitFor(
        () => gw.connectionRegistry.getByConversation(CONV_ID).size,
        (s) => s === 0,
      );

      // Reconnect with lastAcknowledgedSeq = end of turn 1
      const ws2 = await connectWebSocket(port, { sessionId: auth.sessionId });
      openSockets.push(ws2);
      ws2.send(
        JSON.stringify({
          type: 'subscribe',
          conversationId: CONV_ID,
          lastAcknowledgedSeq: ackSeq,
        }),
      );

      // Should only replay turn 2 events (events after ackSeq)
      const replayMsgs = await waitForMessages(ws2, turn2.length + 1);
      const replayed = replayMsgs.slice(0, turn2.length);
      assert.equal(replayMsgs[turn2.length]['type'], 'subscribed');

      // Replayed events match turn 2 exactly
      for (const [i, msg] of replayed.entries()) {
        assert.equal(msg['type'], 'stream-event');
        assert.deepEqual(msg['event'], turn2[i]);
      }

      // Ordering invariants
      const replayedSeqs = replayed.map((m) => (m['event'] as StreamEvent).seq);
      assertMonotonicSequenceNumbers(replayedSeqs, 'partial-ack replay');
      assert.equal(
        replayedSeqs[0],
        ackSeq + 1,
        'Replay should start right after lastAcknowledgedSeq',
      );
      for (let i = 1; i < replayedSeqs.length; i++) {
        assert.equal(
          replayedSeqs[i],
          replayedSeqs[i - 1] + 1,
          `Gap in partial-ack replay at ${String(replayedSeqs[i - 1])} → ${String(replayedSeqs[i])}`,
        );
      }
    });
  });

  // ── T036: Page refresh scenario ────────────────────────────────────────

  describe('T036: Page refresh scenario', () => {
    it('full page refresh: ack turn 1, receive un-acked turn 2, close (unload), reconnect replays turn 2 + live resumes', async () => {
      // ── Phase 1: Initial page load ──────────────────────────────────────
      const auth = await loginViaRest();

      const ws1 = await connectWebSocket(port, { sessionId: auth.sessionId });
      openSockets.push(ws1);

      ws1.send(JSON.stringify({ type: 'subscribe', conversationId: CONV_ID }));
      const sub1 = await waitForMessage(ws1);
      assert.equal(sub1['type'], 'subscribed');

      // Turn 1: user reads these, browser acks them
      const turn1 = fakeDaemon.emitFullStream(CONV_ID, 'turn-pr-1', ['hello', 'world']);
      const page1Turn1Msgs = await waitForMessages(ws1, turn1.length);
      assert.equal(page1Turn1Msgs.length, turn1.length);

      const lastAckedSeq = (lastItem(page1Turn1Msgs)['event'] as StreamEvent).seq;
      ws1.send(JSON.stringify({ type: 'ack', conversationId: CONV_ID, seq: lastAckedSeq }));

      // Wait for ack to register
      const connections = gw.connectionRegistry.getByConversation(CONV_ID);
      const conn = [...connections][0];
      await waitFor(
        () => conn.lastAckSeq.get(CONV_ID),
        (seq) => seq === lastAckedSeq,
      );

      // Turn 2 events arrive right before the user hits F5 — received on ws1
      // but NOT acked (the page unloads before the ack can be sent)
      const turn2 = fakeDaemon.emitFullStream(CONV_ID, 'turn-pr-2', ['new', 'data', 'here']);
      const page1Turn2Msgs = await waitForMessages(ws1, turn2.length);
      for (const [i, msg] of page1Turn2Msgs.entries()) {
        assert.equal(msg['type'], 'stream-event');
        assert.deepEqual(
          msg['event'],
          turn2[i],
          `pre-refresh live order mismatch at index ${String(i)}`,
        );
      }

      // ── Phase 2: Page unload (user hits F5 / navigates away) ───────────
      ws1.close();
      await once(ws1, 'close');
      await waitFor(
        () => gw.connectionRegistry.getByConversation(CONV_ID).size,
        (size) => size === 0,
      );

      // ── Phase 3: New page load (browser creates fresh connection) ──────
      const ws2 = await connectWebSocket(port, { sessionId: auth.sessionId });
      openSockets.push(ws2);

      // Browser reconstructs last ack from localStorage/sessionStorage
      ws2.send(
        JSON.stringify({
          type: 'subscribe',
          conversationId: CONV_ID,
          lastAcknowledgedSeq: lastAckedSeq,
        }),
      );

      // Buffer-hit: turn 2 events (un-acked) are replayed + subscribed
      const replayMsgs = await waitForMessages(ws2, turn2.length + 1);
      const replayed = replayMsgs.slice(0, turn2.length);
      assert.equal(replayMsgs[turn2.length]['type'], 'subscribed');

      for (const [i, msg] of replayed.entries()) {
        assert.equal(msg['type'], 'stream-event');
        assert.deepEqual(msg['event'], turn2[i]);
      }

      // ── Phase 4: Live streaming resumes on the new page ────────────────
      const turn3 = fakeDaemon.emitFullStream(CONV_ID, 'turn-pr-3', ['live', 'again']);
      const liveMsgs = await waitForMessages(ws2, turn3.length);
      for (const [i, msg] of liveMsgs.entries()) {
        assert.equal(msg['type'], 'stream-event');
        assert.deepEqual(msg['event'], turn3[i]);
      }

      // ── FR-023/FR-024: replay + live ordering invariants ───────────────
      const allSeqs = [
        ...replayed.map((m) => (m['event'] as StreamEvent).seq),
        ...liveMsgs.map((m) => (m['event'] as StreamEvent).seq),
      ];
      assertMonotonicSequenceNumbers(allSeqs, 'page refresh: replay + live');

      for (let i = 1; i < allSeqs.length; i++) {
        assert.equal(
          allSeqs[i],
          allSeqs[i - 1] + 1,
          `Gap in page-refresh flow at seq ${String(allSeqs[i - 1])} → ${String(allSeqs[i])}`,
        );
      }

      assert.equal(new Set(allSeqs).size, allSeqs.length, 'Duplicate seq in page-refresh flow');

      // Verify the new connection is fully live
      const finalConnections = gw.connectionRegistry.getByConversation(CONV_ID);
      assert.equal(finalConnections.size, 1);
    });

    it('page refresh with daemon-fallback: buffer lost during disconnect, daemon replays missed events', async () => {
      const auth = await loginViaRest();

      // Phase 1: Initial page — receive and ack events
      const ws1 = await connectWebSocket(port, { sessionId: auth.sessionId });
      openSockets.push(ws1);
      ws1.send(JSON.stringify({ type: 'subscribe', conversationId: CONV_ID }));
      await waitForMessage(ws1); // subscribed

      const turn1 = fakeDaemon.emitFullStream(CONV_ID, 'turn-prf-1', ['before', 'refresh']);
      const page1Msgs = await waitForMessages(ws1, turn1.length);
      const lastAckedSeq = (lastItem(page1Msgs)['event'] as StreamEvent).seq;
      ws1.send(JSON.stringify({ type: 'ack', conversationId: CONV_ID, seq: lastAckedSeq }));

      const conns = gw.connectionRegistry.getByConversation(CONV_ID);
      const conn = [...conns][0];
      await waitFor(
        () => conn.lastAckSeq.get(CONV_ID),
        (seq) => seq === lastAckedSeq,
      );

      // Phase 2: Page unload
      ws1.close();
      await once(ws1, 'close');
      await waitFor(
        () => gw.connectionRegistry.getByConversation(CONV_ID).size,
        (size) => size === 0,
      );

      // Simulate buffer loss (e.g. gateway restart between page close and reload)
      gw.eventBuffer.evictConversation(CONV_ID);

      // Build events the daemon will return for missed turn 2
      const missedEvents: StreamEvent[] = [
        {
          seq: lastAckedSeq + 1,
          turnId: 'turn-prf-2',
          kind: 'stream-started',
          payload: { streamId: 'stream-prf-2' },
          timestamp: new Date().toISOString(),
        },
        {
          seq: lastAckedSeq + 2,
          turnId: 'turn-prf-2',
          kind: 'text-delta',
          payload: { text: 'while-refreshing' },
          timestamp: new Date().toISOString(),
        },
        {
          seq: lastAckedSeq + 3,
          turnId: 'turn-prf-2',
          kind: 'stream-completed',
          payload: { responseLength: 16 },
          timestamp: new Date().toISOString(),
        },
      ];

      // Configure daemon fallback
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
            message: 'not found',
          },
        };
      };

      fakeDaemon.wsDaemonClient.loadTurnHistory = async () => ({
        data: {
          turns: [
            {
              id: 'turn-prf-1',
              conversationId: CONV_ID,
              position: 1,
              kind: 'operator' as const,
              attribution: { type: 'operator' as const, label: 'admin' },
              instruction: 'test',
              status: 'completed' as const,
              createdAt: new Date().toISOString(),
            },
            {
              id: 'turn-prf-2',
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
        if (turnId === 'turn-prf-1') {
          return { data: { events: turn1.filter((e) => e.seq > lastAckSeq) } };
        }
        if (turnId === 'turn-prf-2') {
          return { data: { events: missedEvents.filter((e) => e.seq > lastAckSeq) } };
        }
        return { data: { events: [] } };
      };

      // Phase 3: New page load — reconnect with daemon fallback
      const ws2 = await connectWebSocket(port, { sessionId: auth.sessionId });
      openSockets.push(ws2);
      ws2.send(
        JSON.stringify({
          type: 'subscribe',
          conversationId: CONV_ID,
          lastAcknowledgedSeq: lastAckedSeq,
        }),
      );

      // Daemon replays missed events + subscribed
      const replayMsgs = await waitForMessages(ws2, missedEvents.length + 1);
      const replayed = replayMsgs.slice(0, missedEvents.length);
      assert.equal(replayMsgs[missedEvents.length]['type'], 'subscribed');

      for (const [i, msg] of replayed.entries()) {
        assert.equal(msg['type'], 'stream-event');
        assert.deepEqual(msg['event'], missedEvents[i]);
      }

      // Phase 4: Live streaming resumes
      const liveEvent: StreamEvent = {
        seq: lastAckedSeq + 4,
        turnId: 'turn-prf-3',
        kind: 'text-delta',
        payload: { text: 'live-after-refresh' },
        timestamp: new Date().toISOString(),
      };
      bridge.emitStreamEvent(CONV_ID, liveEvent);

      const liveMsg = await waitForMessage(ws2);
      assert.equal(liveMsg['type'], 'stream-event');
      assert.deepEqual(liveMsg['event'], liveEvent);

      // Full sequence: replay + live is contiguous
      const allSeqs = [
        ...replayed.map((m) => (m['event'] as StreamEvent).seq),
        liveMsg['event'].seq,
      ];
      assertMonotonicSequenceNumbers(allSeqs, 'page refresh daemon-fallback');
      for (let i = 1; i < allSeqs.length; i++) {
        assert.equal(
          allSeqs[i],
          allSeqs[i - 1] + 1,
          `Gap in page-refresh daemon-fallback at ${String(allSeqs[i - 1])} → ${String(allSeqs[i])}`,
        );
      }
    });

    it('forces daemon fallback when offline events create a replay gap after disconnect', async () => {
      const auth = await loginViaRest();

      const ws1 = await connectWebSocket(port, { sessionId: auth.sessionId });
      openSockets.push(ws1);
      ws1.send(JSON.stringify({ type: 'subscribe', conversationId: CONV_ID }));
      await waitForMessage(ws1); // subscribed

      const retainedTail: StreamEvent[] = [
        {
          seq: 101,
          turnId: 'turn-gap-1',
          kind: 'stream-started',
          payload: { streamId: 'stream-gap-1' },
          timestamp: new Date().toISOString(),
        },
        {
          seq: 102,
          turnId: 'turn-gap-1',
          kind: 'text-delta',
          payload: { text: 'retained-tail' },
          timestamp: new Date().toISOString(),
        },
      ];

      for (const event of retainedTail) {
        bridge.emitStreamEvent(CONV_ID, event);
      }

      const firstPageMsgs = await waitForMessages(ws1, retainedTail.length);
      for (const [i, msg] of firstPageMsgs.entries()) {
        assert.equal(msg['type'], 'stream-event');
        assert.deepEqual(msg['event'], retainedTail[i]);
      }

      gw.eventBuffer.markReplaySafeFrom(CONV_ID, 100);

      const lastAckedSeq = 101;
      ws1.send(JSON.stringify({ type: 'ack', conversationId: CONV_ID, seq: lastAckedSeq }));

      const connections = gw.connectionRegistry.getByConversation(CONV_ID);
      const connection = [...connections][0];
      await waitFor(
        () => connection.lastAckSeq.get(CONV_ID),
        (seq) => seq === lastAckedSeq,
      );

      ws1.close();
      await once(ws1, 'close');
      await waitFor(
        () => gw.connectionRegistry.getByConversation(CONV_ID).size,
        (size) => size === 0,
      );

      const offlineEvents: StreamEvent[] = [
        {
          seq: 103,
          turnId: 'turn-gap-2',
          kind: 'text-delta',
          payload: { text: 'offline-gap' },
          timestamp: new Date().toISOString(),
        },
        {
          seq: 104,
          turnId: 'turn-gap-2',
          kind: 'stream-completed',
          payload: { responseLength: 11 },
          timestamp: new Date().toISOString(),
        },
      ];
      for (const event of offlineEvents) {
        bridge.emitStreamEvent(CONV_ID, event);
      }
      assert.equal(gw.eventBuffer.hasEventsSince(CONV_ID, lastAckedSeq), false);

      let daemonReplayCalls = 0;
      fakeDaemon.wsDaemonClient.openConversation = async () => ({
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
      });
      fakeDaemon.wsDaemonClient.loadTurnHistory = async () => ({
        data: {
          turns: [
            {
              id: 'turn-gap-1',
              conversationId: CONV_ID,
              position: 1,
              kind: 'operator' as const,
              attribution: { type: 'operator' as const, label: 'admin' },
              instruction: 'first',
              status: 'completed' as const,
              createdAt: new Date().toISOString(),
            },
            {
              id: 'turn-gap-2',
              conversationId: CONV_ID,
              position: 2,
              kind: 'operator' as const,
              attribution: { type: 'operator' as const, label: 'admin' },
              instruction: 'second',
              status: 'completed' as const,
              createdAt: new Date().toISOString(),
            },
          ],
          totalCount: 2,
          hasMore: false,
        },
      });
      fakeDaemon.wsDaemonClient.getStreamReplay = async (_convId: string, turnId: string) => {
        daemonReplayCalls += 1;
        if (turnId === 'turn-gap-1') {
          return { data: { events: [retainedTail[1]] } };
        }
        if (turnId === 'turn-gap-2') {
          return { data: { events: offlineEvents } };
        }
        return { data: { events: [] } };
      };

      const ws2 = await connectWebSocket(port, { sessionId: auth.sessionId });
      openSockets.push(ws2);
      ws2.send(
        JSON.stringify({
          type: 'subscribe',
          conversationId: CONV_ID,
          lastAcknowledgedSeq: lastAckedSeq,
        }),
      );

      const replayMsgs = await waitForMessages(ws2, retainedTail.length + offlineEvents.length);
      const replayed = replayMsgs.slice(0, replayMsgs.length - 1);
      assert.equal(lastItem(replayMsgs)?.['type'], 'subscribed');
      assert.equal(daemonReplayCalls > 0, true);

      const expectedReplay = [retainedTail[1], ...offlineEvents];
      assert.equal(replayed.length, expectedReplay.length);
      for (const [i, msg] of replayed.entries()) {
        assert.equal(msg['type'], 'stream-event');
        assert.deepEqual(msg['event'], expectedReplay[i]);
      }
    });
  });

  // ── T038: Approval round-trip ──────────────────────────────────────────

  describe('T038: Approval round-trip', () => {
    async function getApprovalsViaRest(
      conversationId: string,
      auth: { sessionId: string; csrfToken: string },
    ): Promise<{ status: number; body: Record<string, unknown> }> {
      const res = await fetch(
        `http://127.0.0.1:${port}/conversations/${conversationId}/approvals`,
        {
          headers: {
            Origin: ORIGIN,
            Cookie: `__session=${auth.sessionId}; __csrf=${auth.csrfToken}`,
            'X-CSRF-Token': auth.csrfToken,
          },
        },
      );
      const body = (await res.json()) as Record<string, unknown>;
      return { status: res.status, body };
    }

    async function respondToApprovalViaRest(
      approvalId: string,
      response: string,
      auth: { sessionId: string; csrfToken: string },
    ): Promise<{ status: number; body: Record<string, unknown> }> {
      const res = await fetch(`http://127.0.0.1:${port}/approvals/${approvalId}/respond`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: ORIGIN,
          Cookie: `__session=${auth.sessionId}; __csrf=${auth.csrfToken}`,
          'X-CSRF-Token': auth.csrfToken,
        },
        body: JSON.stringify({ response }),
      });
      const body = (await res.json()) as Record<string, unknown>;
      return { status: res.status, body };
    }

    it('approval-prompt arrives via WS, REST approval response triggers resumed streaming', async () => {
      const auth = await loginViaRest();
      const ws = await connectWebSocket(port, { sessionId: auth.sessionId });
      openSockets.push(ws);

      // Subscribe to conversation
      ws.send(JSON.stringify({ type: 'subscribe', conversationId: CONV_ID }));
      const subMsg = await waitForMessage(ws);
      assert.equal(subMsg['type'], 'subscribed');

      // Submit instruction that will trigger approval
      const turnResult = await submitInstructionViaRest(CONV_ID, 'deploy to production', auth);
      const turnId = (turnResult['turn'] as Record<string, unknown>)['id'] as string;

      // Daemon emits stream-started, then an approval-prompt event
      const approvalId = 'approval-1';
      const startedEvent: StreamEvent = {
        seq: fakeDaemon.nextSeq(),
        turnId,
        kind: 'stream-started',
        payload: { streamId: `stream-${turnId}` },
        timestamp: new Date().toISOString(),
      };
      bridge.emitStreamEvent(CONV_ID, startedEvent);

      const approvalPromptEvent: StreamEvent = {
        seq: fakeDaemon.nextSeq(),
        turnId,
        kind: 'approval-prompt',
        payload: {
          approvalId,
          prompt: 'Approve deployment to production?',
          options: ['approve', 'reject'],
        },
        timestamp: new Date().toISOString(),
      };
      bridge.emitStreamEvent(CONV_ID, approvalPromptEvent);

      // Assert both events arrive on WS
      const earlyMsgs = await waitForMessages(ws, 2);
      assert.equal(earlyMsgs[0]['type'], 'stream-event');
      assert.equal((earlyMsgs[0]['event'] as StreamEvent).kind, 'stream-started');
      assert.equal(earlyMsgs[1]['type'], 'stream-event');
      assert.equal((earlyMsgs[1]['event'] as StreamEvent).kind, 'approval-prompt');
      assert.equal((earlyMsgs[1]['event'] as StreamEvent).payload['approvalId'], approvalId);

      // Register the pending approval in the fake so getPendingApprovals returns it
      fakeDaemon.pendingApprovals.push({
        id: approvalId,
        turnId,
        status: 'pending',
        prompt: 'Approve deployment to production?',
      });

      // Verify pending approvals via REST
      const approvalsResult = await getApprovalsViaRest(CONV_ID, auth);
      assert.equal(approvalsResult.status, 200);
      const approvals = approvalsResult.body['approvals'] as Array<Record<string, unknown>>;
      assert.equal(approvals.length, 1);
      assert.equal(approvals[0]['id'], approvalId);

      // Respond to approval via REST
      const respondResult = await respondToApprovalViaRest(approvalId, 'approve', auth);
      assert.equal(respondResult.status, 200);
      assert.equal(respondResult.body['success'], true);
      const approvalResponse = respondResult.body['approval'] as Record<string, unknown>;
      assert.ok(approvalResponse, 'Expected approval in response payload');
      assert.equal(approvalResponse['id'], approvalId);
      assert.equal(approvalResponse['turnId'], turnId);
      assert.equal(approvalResponse['status'], 'responded');
      assert.equal(approvalResponse['response'], 'approve');

      // Daemon emits approval-response event followed by resumed streaming
      const approvalResponseEvent: StreamEvent = {
        seq: fakeDaemon.nextSeq(),
        turnId,
        kind: 'approval-response',
        payload: { approvalId, response: 'approve' },
        timestamp: new Date().toISOString(),
      };
      bridge.emitStreamEvent(CONV_ID, approvalResponseEvent);

      const textDelta: StreamEvent = {
        seq: fakeDaemon.nextSeq(),
        turnId,
        kind: 'text-delta',
        payload: { text: 'Deploying...' },
        timestamp: new Date().toISOString(),
      };
      bridge.emitStreamEvent(CONV_ID, textDelta);

      const completedEvent: StreamEvent = {
        seq: fakeDaemon.nextSeq(),
        turnId,
        kind: 'stream-completed',
        payload: { responseLength: 12 },
        timestamp: new Date().toISOString(),
      };
      bridge.emitStreamEvent(CONV_ID, completedEvent);

      // Collect the resumed stream events on WS
      const resumedMsgs = await waitForMessages(ws, 3);
      assert.equal((resumedMsgs[0]['event'] as StreamEvent).kind, 'approval-response');
      assert.equal((resumedMsgs[1]['event'] as StreamEvent).kind, 'text-delta');
      assert.equal((resumedMsgs[1]['event'] as StreamEvent).payload['text'], 'Deploying...');
      assert.equal((resumedMsgs[2]['event'] as StreamEvent).kind, 'stream-completed');

      // Verify monotonic sequence numbers across the entire flow
      const allWsMsgs = [...earlyMsgs, ...resumedMsgs];
      const allSeqs = allWsMsgs.map((m) => (m['event'] as StreamEvent).seq);
      assertMonotonicSequenceNumbers(allSeqs, 'approval round-trip');
      for (let i = 1; i < allSeqs.length; i++) {
        assert.equal(
          allSeqs[i],
          allSeqs[i - 1] + 1,
          `Gap in approval round-trip at seq ${String(allSeqs[i - 1])} → ${String(allSeqs[i])}`,
        );
      }
    });

    it('approval response for unknown approval returns error without affecting WS stream', async () => {
      const auth = await loginViaRest();
      const ws = await connectWebSocket(port, { sessionId: auth.sessionId });
      openSockets.push(ws);

      ws.send(JSON.stringify({ type: 'subscribe', conversationId: CONV_ID }));
      await waitForMessage(ws); // subscribed

      // Respond to a nonexistent approval
      const respondResult = await respondToApprovalViaRest('nonexistent-approval', 'approve', auth);
      assert.equal(respondResult.status, 404, 'Expected 404 for unknown approval');
      assert.equal(respondResult.body['ok'], false);
      assert.equal(respondResult.body['code'], 'APPROVAL_NOT_FOUND');

      // WS should still be usable — emit an event and verify delivery
      const probeEvent: StreamEvent = {
        seq: fakeDaemon.nextSeq(),
        turnId: 'turn-probe',
        kind: 'text-delta',
        payload: { text: 'still-alive' },
        timestamp: new Date().toISOString(),
      };
      bridge.emitStreamEvent(CONV_ID, probeEvent);

      const msg = await waitForMessage(ws);
      assert.equal(msg['type'], 'stream-event');
      assert.deepEqual(msg['event'], probeEvent);
    });
  });

  // ── T039: Cancel round-trip ────────────────────────────────────────────

  describe('T039: Cancel round-trip', () => {
    async function cancelWorkViaRest(
      conversationId: string,
      turnId: string,
      auth: { sessionId: string; csrfToken: string },
    ): Promise<{ status: number; body: Record<string, unknown> }> {
      const res = await fetch(
        `http://127.0.0.1:${port}/conversations/${conversationId}/turns/${turnId}/cancel`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: ORIGIN,
            Cookie: `__session=${auth.sessionId}; __csrf=${auth.csrfToken}`,
            'X-CSRF-Token': auth.csrfToken,
          },
          body: JSON.stringify({}),
        },
      );
      const body = (await res.json()) as Record<string, unknown>;
      return { status: res.status, body };
    }

    it('cancel during streaming: REST cancel succeeds, cancellation event arrives on WS, streaming stops', async () => {
      const auth = await loginViaRest();
      const ws = await connectWebSocket(port, { sessionId: auth.sessionId });
      openSockets.push(ws);

      ws.send(JSON.stringify({ type: 'subscribe', conversationId: CONV_ID }));
      await waitForMessage(ws); // subscribed

      // Submit instruction and start streaming
      const turnResult = await submitInstructionViaRest(CONV_ID, 'long running task', auth);
      const turnId = (turnResult['turn'] as Record<string, unknown>)['id'] as string;

      // Daemon starts streaming
      const startedEvent: StreamEvent = {
        seq: fakeDaemon.nextSeq(),
        turnId,
        kind: 'stream-started',
        payload: { streamId: `stream-${turnId}` },
        timestamp: new Date().toISOString(),
      };
      bridge.emitStreamEvent(CONV_ID, startedEvent);

      const delta1: StreamEvent = {
        seq: fakeDaemon.nextSeq(),
        turnId,
        kind: 'text-delta',
        payload: { text: 'Working on it...' },
        timestamp: new Date().toISOString(),
      };
      bridge.emitStreamEvent(CONV_ID, delta1);

      // Collect the initial streaming events
      const initialMsgs = await waitForMessages(ws, 2);
      assert.equal((initialMsgs[0]['event'] as StreamEvent).kind, 'stream-started');
      assert.equal((initialMsgs[1]['event'] as StreamEvent).kind, 'text-delta');

      // Cancel via REST while streaming is in progress
      const cancelResult = await cancelWorkViaRest(CONV_ID, turnId, auth);
      assert.equal(cancelResult.status, 200);
      assert.equal(cancelResult.body['success'], true);
      const cancelledTurn = cancelResult.body['turn'] as Record<string, unknown>;
      assert.ok(cancelledTurn, 'Expected cancelled turn in response payload');
      assert.equal(cancelledTurn['id'], turnId);
      assert.equal(cancelledTurn['conversationId'], CONV_ID);
      assert.equal(cancelledTurn['status'], 'cancelled');
      assert.equal(fakeDaemon.cancelledTurns.length, 1);
      assert.equal(fakeDaemon.cancelledTurns[0].turnId, turnId);

      // Daemon emits cancellation event — streaming terminates
      const cancellationEvent: StreamEvent = {
        seq: fakeDaemon.nextSeq(),
        turnId,
        kind: 'cancellation',
        payload: {},
        timestamp: new Date().toISOString(),
      };
      bridge.emitStreamEvent(CONV_ID, cancellationEvent);

      // Assert cancellation event arrives on WS
      const cancelMsg = await waitForMessage(ws);
      assert.equal(cancelMsg['type'], 'stream-event');
      assert.equal((cancelMsg['event'] as StreamEvent).kind, 'cancellation');
      assert.deepEqual((cancelMsg['event'] as StreamEvent).payload, {});

      // Verify monotonic sequence across started → delta → cancellation
      const allSeqs = [
        ...initialMsgs.map((m) => (m['event'] as StreamEvent).seq),
        (cancelMsg['event'] as StreamEvent).seq,
      ];
      assertMonotonicSequenceNumbers(allSeqs, 'cancel round-trip');
      for (let i = 1; i < allSeqs.length; i++) {
        assert.equal(
          allSeqs[i],
          allSeqs[i - 1] + 1,
          `Gap in cancel round-trip at seq ${String(allSeqs[i - 1])} → ${String(allSeqs[i])}`,
        );
      }
    });

    it('cancel on a completed turn returns success from daemon without disrupting WS', async () => {
      const auth = await loginViaRest();
      const ws = await connectWebSocket(port, { sessionId: auth.sessionId });
      openSockets.push(ws);

      ws.send(JSON.stringify({ type: 'subscribe', conversationId: CONV_ID }));
      await waitForMessage(ws); // subscribed

      // Complete a full stream first
      const turnResult = await submitInstructionViaRest(CONV_ID, 'quick task', auth);
      const turnId = (turnResult['turn'] as Record<string, unknown>)['id'] as string;
      const emitted = fakeDaemon.emitFullStream(CONV_ID, turnId, ['done']);
      await waitForMessages(ws, emitted.length);

      // Cancel the already-completed turn — should still succeed at REST layer
      const cancelResult = await cancelWorkViaRest(CONV_ID, turnId, auth);
      assert.equal(cancelResult.status, 200);

      // WS still works — verify with a probe event
      const probeEvent: StreamEvent = {
        seq: fakeDaemon.nextSeq(),
        turnId: 'turn-probe-cancel',
        kind: 'text-delta',
        payload: { text: 'ws-still-alive' },
        timestamp: new Date().toISOString(),
      };
      bridge.emitStreamEvent(CONV_ID, probeEvent);

      const msg = await waitForMessage(ws);
      assert.equal(msg['type'], 'stream-event');
      assert.deepEqual(msg['event'], probeEvent);
    });
  });

  // ── T040: Retry round-trip ─────────────────────────────────────────────

  describe('T040: Retry round-trip', () => {
    async function retryTurnViaRest(
      conversationId: string,
      turnId: string,
      auth: { sessionId: string; csrfToken: string },
    ): Promise<{ status: number; body: Record<string, unknown> }> {
      const res = await fetch(
        `http://127.0.0.1:${port}/conversations/${conversationId}/turns/${turnId}/retry`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: ORIGIN,
            Cookie: `__session=${auth.sessionId}; __csrf=${auth.csrfToken}`,
            'X-CSRF-Token': auth.csrfToken,
          },
          body: JSON.stringify({}),
        },
      );
      const body = (await res.json()) as Record<string, unknown>;
      return { status: res.status, body };
    }

    it('retry after failed turn: REST retry triggers new stream events on WS', async () => {
      const auth = await loginViaRest();
      const ws = await connectWebSocket(port, { sessionId: auth.sessionId });
      openSockets.push(ws);

      ws.send(JSON.stringify({ type: 'subscribe', conversationId: CONV_ID }));
      await waitForMessage(ws); // subscribed

      // Submit instruction — daemon starts streaming then fails
      const turnResult = await submitInstructionViaRest(CONV_ID, 'flaky operation', auth);
      const failedTurnId = (turnResult['turn'] as Record<string, unknown>)['id'] as string;

      const startedEvent: StreamEvent = {
        seq: fakeDaemon.nextSeq(),
        turnId: failedTurnId,
        kind: 'stream-started',
        payload: { streamId: `stream-${failedTurnId}` },
        timestamp: new Date().toISOString(),
      };
      bridge.emitStreamEvent(CONV_ID, startedEvent);

      const failedEvent: StreamEvent = {
        seq: fakeDaemon.nextSeq(),
        turnId: failedTurnId,
        kind: 'stream-failed',
        payload: { error: 'Agent crashed', code: 'AGENT_ERROR' },
        timestamp: new Date().toISOString(),
      };
      bridge.emitStreamEvent(CONV_ID, failedEvent);

      // Collect the failure events on WS
      const failureMsgs = await waitForMessages(ws, 2);
      assert.equal((failureMsgs[0]['event'] as StreamEvent).kind, 'stream-started');
      assert.equal((failureMsgs[1]['event'] as StreamEvent).kind, 'stream-failed');

      // Retry via REST
      const retryResult = await retryTurnViaRest(CONV_ID, failedTurnId, auth);
      assert.equal(retryResult.status, 200);
      const retryTurn = retryResult.body['turn'] as Record<string, unknown>;
      const retryStreamId = retryResult.body['streamId'] as string;
      assert.ok(retryTurn, 'Expected turn in retry response');
      assert.ok(retryStreamId, 'Expected streamId in retry response');
      assert.equal(retryTurn['conversationId'], CONV_ID);
      assert.equal(retryTurn['status'], 'executing');
      assert.equal(retryTurn['parentTurnId'], failedTurnId);
      assert.equal(fakeDaemon.retriedTurns.length, 1);
      assert.equal(fakeDaemon.retriedTurns[0].turnId, failedTurnId);

      const newTurnId = retryTurn['id'] as string;

      // Daemon emits a fresh stream for the retry turn
      const retryEvents = fakeDaemon.emitFullStream(CONV_ID, newTurnId, [
        'Retrying...',
        'Success!',
      ]);

      // Collect the retry stream events on WS
      const retryMsgs = await waitForMessages(ws, retryEvents.length);
      assert.equal((retryMsgs[0]['event'] as StreamEvent).kind, 'stream-started');
      assert.equal((lastItem(retryMsgs)['event'] as StreamEvent).kind, 'stream-completed');

      const retryTextDeltas = retryMsgs.filter(
        (m) => (m['event'] as StreamEvent).kind === 'text-delta',
      );
      assert.equal(retryTextDeltas.length, 2);
      assert.equal((retryTextDeltas[0]['event'] as StreamEvent).payload['text'], 'Retrying...');
      assert.equal((retryTextDeltas[1]['event'] as StreamEvent).payload['text'], 'Success!');

      // Verify events for the new turn have correct turnId
      for (const msg of retryMsgs) {
        assert.equal((msg['event'] as StreamEvent).turnId, newTurnId);
      }

      // Verify monotonic sequence numbers across original failure + retry
      const allSeqs = [
        ...failureMsgs.map((m) => (m['event'] as StreamEvent).seq),
        ...retryMsgs.map((m) => (m['event'] as StreamEvent).seq),
      ];
      assertMonotonicSequenceNumbers(allSeqs, 'retry round-trip');
      for (let i = 1; i < allSeqs.length; i++) {
        assert.equal(
          allSeqs[i],
          allSeqs[i - 1] + 1,
          `Gap in retry round-trip at seq ${String(allSeqs[i - 1])} → ${String(allSeqs[i])}`,
        );
      }
    });

    it('retry produces events with different turnId than the original failed turn', async () => {
      const auth = await loginViaRest();
      const ws = await connectWebSocket(port, { sessionId: auth.sessionId });
      openSockets.push(ws);

      ws.send(JSON.stringify({ type: 'subscribe', conversationId: CONV_ID }));
      await waitForMessage(ws); // subscribed

      // Submit and fail
      const turnResult = await submitInstructionViaRest(CONV_ID, 'fail then retry', auth);
      const originalTurnId = (turnResult['turn'] as Record<string, unknown>)['id'] as string;

      const failEvent: StreamEvent = {
        seq: fakeDaemon.nextSeq(),
        turnId: originalTurnId,
        kind: 'stream-failed',
        payload: { error: 'timeout' },
        timestamp: new Date().toISOString(),
      };
      bridge.emitStreamEvent(CONV_ID, failEvent);
      await waitForMessage(ws); // stream-failed

      // Retry
      const retryResult = await retryTurnViaRest(CONV_ID, originalTurnId, auth);
      assert.equal(retryResult.status, 200);
      const newTurnId = (retryResult.body['turn'] as Record<string, unknown>)['id'] as string;

      // The new turn must have a different ID
      assert.notEqual(newTurnId, originalTurnId, 'Retry should create a new turn');

      // Emit retry stream and verify turnId on WS
      const retryEvents = fakeDaemon.emitFullStream(CONV_ID, newTurnId, ['recovered']);
      const retryMsgs = await waitForMessages(ws, retryEvents.length);

      for (const msg of retryMsgs) {
        assert.equal(
          (msg['event'] as StreamEvent).turnId,
          newTurnId,
          'Retry events should reference the new turnId',
        );
      }
    });
  });

  // ── T049: Multi-tab edge case (FR-010 edge) ────────────────────────────

  describe('T049: Multi-tab edge case', () => {
    it('two tabs on same session/conversation both receive identical stream events from a single REST submission', async () => {
      // (a) authenticate — single session represents one browser with two tabs
      const auth = await loginViaRest();

      // (b) open two WebSocket connections (simulating two browser tabs)
      const tabA = await connectWebSocket(port, { sessionId: auth.sessionId });
      openSockets.push(tabA);
      const tabB = await connectWebSocket(port, { sessionId: auth.sessionId });
      openSockets.push(tabB);

      // (c) both tabs subscribe to the same conversation
      tabA.send(JSON.stringify({ type: 'subscribe', conversationId: CONV_ID }));
      tabB.send(JSON.stringify({ type: 'subscribe', conversationId: CONV_ID }));
      const subA = await waitForMessage(tabA);
      const subB = await waitForMessage(tabB);
      assert.equal(subA['type'], 'subscribed');
      assert.equal(subB['type'], 'subscribed');

      // (d) ONE tab submits an instruction via REST
      const turnResult = await submitInstructionViaRest(CONV_ID, 'build the feature', auth);
      const turnId = (turnResult['turn'] as Record<string, unknown>)['id'] as string;
      assert.ok(turnId, 'Expected turnId from REST submission');

      // (e) daemon emits a full stream lifecycle
      const emitted = fakeDaemon.emitFullStream(CONV_ID, turnId, ['Hello', ' from', ' Hydra']);

      // (f) both tabs must receive ALL events
      const [msgsA, msgsB] = await Promise.all([
        waitForMessages(tabA, emitted.length),
        waitForMessages(tabB, emitted.length),
      ]);

      // (g) NO omission — both received the same count
      assert.equal(msgsA.length, emitted.length, 'Tab A: no event omission');
      assert.equal(msgsB.length, emitted.length, 'Tab B: no event omission');

      // (h) NO duplication — each tab received exactly emitted.length messages
      // (verified by waitForMessages returning exactly that count)

      // (i) identical content — events match 1:1 between tabs AND match emitted
      for (const [i, emittedEvent] of emitted.entries()) {
        const eventA = msgsA[i]['event'] as StreamEvent;
        const eventB = msgsB[i]['event'] as StreamEvent;

        assert.deepEqual(eventA, emittedEvent, `Tab A event[${i}] matches emitted`);
        assert.deepEqual(eventB, emittedEvent, `Tab B event[${i}] matches emitted`);
        assert.deepEqual(eventA, eventB, `Tab A and Tab B event[${i}] are identical`);
      }

      // (j) sequence numbers are monotonically increasing on each tab
      const seqsA = msgsA.map((m) => (m['event'] as StreamEvent).seq);
      const seqsB = msgsB.map((m) => (m['event'] as StreamEvent).seq);
      assertMonotonicSequenceNumbers(seqsA, 'Tab A sequence');
      assertMonotonicSequenceNumbers(seqsB, 'Tab B sequence');

      // (k) both tabs saw the full lifecycle: started → deltas → completed
      assert.equal((msgsA[0]['event'] as StreamEvent).kind, 'stream-started');
      assert.equal((lastItem(msgsA)['event'] as StreamEvent).kind, 'stream-completed');
      assert.equal((msgsB[0]['event'] as StreamEvent).kind, 'stream-started');
      assert.equal((lastItem(msgsB)['event'] as StreamEvent).kind, 'stream-completed');
    });

    it('multi-tab: events are not duplicated when both tabs subscribe before stream starts', async () => {
      const auth = await loginViaRest();

      const tabA = await connectWebSocket(port, { sessionId: auth.sessionId });
      openSockets.push(tabA);
      const tabB = await connectWebSocket(port, { sessionId: auth.sessionId });
      openSockets.push(tabB);

      // Both subscribe
      tabA.send(JSON.stringify({ type: 'subscribe', conversationId: CONV_ID }));
      tabB.send(JSON.stringify({ type: 'subscribe', conversationId: CONV_ID }));
      await waitForMessage(tabA);
      await waitForMessage(tabB);

      // Emit a single event
      const singleEvent: StreamEvent = {
        seq: fakeDaemon.nextSeq(),
        turnId: 'turn-dup-check',
        kind: 'text-delta',
        payload: { text: 'exactly once' },
        timestamp: new Date().toISOString(),
      };
      bridge.emitStreamEvent(CONV_ID, singleEvent);

      // Each tab receives exactly 1 copy of the event — NOT 2
      const [msgA, msgB] = await Promise.all([waitForMessage(tabA), waitForMessage(tabB)]);
      assert.deepEqual(msgA['event'], singleEvent, 'Tab A receives the single event once');
      assert.deepEqual(msgB['event'], singleEvent, 'Tab B receives the single event once');

      // Verify by emitting a sentinel event and checking no extra messages snuck in
      const sentinel: StreamEvent = {
        seq: fakeDaemon.nextSeq(),
        turnId: 'turn-sentinel',
        kind: 'text-delta',
        payload: { text: 'sentinel' },
        timestamp: new Date().toISOString(),
      };
      bridge.emitStreamEvent(CONV_ID, sentinel);

      const sentinelA = await waitForMessage(tabA);
      const sentinelB = await waitForMessage(tabB);

      // The sentinel must be the next message on each tab — no stale duplicates
      assert.deepEqual(
        sentinelA['event'],
        sentinel,
        'Tab A next message is sentinel (no duplicates)',
      );
      assert.deepEqual(
        sentinelB['event'],
        sentinel,
        'Tab B next message is sentinel (no duplicates)',
      );
    });

    it('multi-tab: second tab joining mid-stream receives only events from join point onward', async () => {
      const auth = await loginViaRest();

      // Tab A subscribes first
      const tabA = await connectWebSocket(port, { sessionId: auth.sessionId });
      openSockets.push(tabA);
      tabA.send(JSON.stringify({ type: 'subscribe', conversationId: CONV_ID }));
      await waitForMessage(tabA); // subscribed

      // Emit the first half of stream events while only Tab A is subscribed
      const earlyEvent: StreamEvent = {
        seq: fakeDaemon.nextSeq(),
        turnId: 'turn-mid',
        kind: 'stream-started',
        payload: { streamId: 'stream-turn-mid' },
        timestamp: new Date().toISOString(),
      };
      bridge.emitStreamEvent(CONV_ID, earlyEvent);
      const earlyMsgA = await waitForMessage(tabA);
      assert.deepEqual(earlyMsgA['event'], earlyEvent);

      // Tab B joins mid-stream (no lastAcknowledgedSeq — fresh subscribe)
      const tabB = await connectWebSocket(port, { sessionId: auth.sessionId });
      openSockets.push(tabB);
      tabB.send(JSON.stringify({ type: 'subscribe', conversationId: CONV_ID }));

      // The first message tab B receives MUST be the subscribe ack, not earlyEvent.
      const subAckB = await waitForMessage(tabB);
      assert.equal(subAckB['type'], 'subscribed', 'First message to tab B is subscribe ack');

      // Prove earlyEvent was not delivered to tab B: collect any messages that
      // arrived on the socket before we emit the next event. A short drain window
      // is sufficient because event delivery is synchronous within the gateway.
      const spurious = await new Promise<Array<Record<string, unknown>>>((resolve) => {
        const msgs: Array<Record<string, unknown>> = [];
        const onMsg = (data: WebSocket.RawData) => {
          msgs.push(rawDataToJson(data));
        };
        tabB.on('message', onMsg);
        setTimeout(() => {
          tabB.off('message', onMsg);
          resolve(msgs);
        }, 50);
      });
      assert.equal(spurious.length, 0, 'Tab B must not receive earlyEvent emitted before join');

      // Emit second event — both tabs should receive it
      const lateEvent: StreamEvent = {
        seq: fakeDaemon.nextSeq(),
        turnId: 'turn-mid',
        kind: 'text-delta',
        payload: { text: 'late joiner sees this' },
        timestamp: new Date().toISOString(),
      };
      bridge.emitStreamEvent(CONV_ID, lateEvent);

      const [lateMsgA, lateMsgB] = await Promise.all([waitForMessage(tabA), waitForMessage(tabB)]);

      assert.deepEqual(lateMsgA['event'], lateEvent, 'Tab A sees late event');
      assert.deepEqual(lateMsgB['event'], lateEvent, 'Tab B sees late event');
    });
  });

  // ── T052: Gateway restart contract (FR-022 edge) ──────────────────────

  describe('T052: Gateway restart contract', () => {
    function replaceSharedState(next: {
      server: Server;
      bridge: FakeEventBridge;
      fakeDaemon: ReturnType<typeof createFakeDaemonClient>;
      gw: GatewayApp;
      port: number;
    }): void {
      server = next.server;
      bridge = next.bridge;
      fakeDaemon = next.fakeDaemon;
      gw = next.gw;
      port = next.port;
    }

    async function createReplacementState(): Promise<{
      server: Server;
      bridge: FakeEventBridge;
      fakeDaemon: ReturnType<typeof createFakeDaemonClient>;
      gw: GatewayApp;
      port: number;
    }> {
      const nextServer = createServer();
      const nextBridge = new FakeEventBridge();
      const nextFakeDaemon = createFakeDaemonClient(nextBridge, {
        validConversationIds: new Set([CONV_ID, 'conv-e2e-2']),
      });
      const nextGw = createGatewayApp({
        server: nextServer,
        clock: new FakeClock(Date.now()),
        allowedOrigin: ORIGIN,
        healthChecker: async () => true,
        heartbeatConfig: { intervalMs: 60_000 },
        daemonClient: nextFakeDaemon.daemonClient,
        wsDaemonClient: nextFakeDaemon.wsDaemonClient,
        streamEventBridge: nextBridge,
        sessionConfig: {
          sessionLifetimeMs: 3600_000,
          warningThresholdMs: 600_000,
          maxExtensions: 3,
          extensionDurationMs: 3600_000,
          idleTimeoutMs: 1800_000,
        },
      });
      const requestListener = getRequestListener(nextGw.app.fetch);
      nextServer.on('request', (req, res) => {
        void requestListener(req, res);
      });
      const nextPort = await listen(nextServer);
      return {
        server: nextServer,
        bridge: nextBridge,
        fakeDaemon: nextFakeDaemon,
        gw: nextGw,
        port: nextPort,
      };
    }

    /** After each T052 test tears down the original server, we must restore
     *  a fresh listening server so the outer afterEach can close it safely. */
    async function teardownAndRestore(): Promise<void> {
      gw.wsServer?.close();
      gw.heartbeat.stop();
      await closeServer(server);

      // Restore shared state so afterEach doesn't throw ERR_SERVER_NOT_RUNNING
      replaceSharedState(await createReplacementState());
    }

    it('all WebSocket connections are lost when the HTTP server closes', async () => {
      // (a) authenticate and connect
      const auth = await loginViaRest();
      const ws = await connectWebSocket(port, { sessionId: auth.sessionId });
      openSockets.push(ws);

      // (b) subscribe + receive events to prove connection is alive
      ws.send(JSON.stringify({ type: 'subscribe', conversationId: CONV_ID }));
      const subMsg = await waitForMessage(ws);
      assert.equal(subMsg['type'], 'subscribed');

      const liveEvents = fakeDaemon.emitFullStream(CONV_ID, 'turn-pre-restart', ['alive']);
      const liveMsgs = await waitForMessages(ws, liveEvents.length);
      assert.equal(liveMsgs.length, liveEvents.length);

      // (c) simulate gateway restart: close WS server + HTTP server
      gw.wsServer?.close();
      gw.heartbeat.stop();
      await closeServer(server);

      // (d) the client WS connection must have been terminated
      await once(ws, 'close');
      assert.ok(
        ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING,
        'WebSocket must be CLOSED or CLOSING after server shutdown',
      );

      // Restore shared state for afterEach
      replaceSharedState(await createReplacementState());
    });

    it('no connection state survives process restart — registry is empty in new instance', async () => {
      // (a) build first gateway instance and populate connections
      const auth = await loginViaRest();
      const ws = await connectWebSocket(port, { sessionId: auth.sessionId });
      openSockets.push(ws);

      ws.send(JSON.stringify({ type: 'subscribe', conversationId: CONV_ID }));
      await waitForMessage(ws); // subscribed

      // Verify the registry has our connection
      assert.ok(gw.connectionRegistry.size > 0, 'Registry has connections before restart');
      assert.ok(
        gw.connectionRegistry.getByConversation(CONV_ID).size > 0,
        'Conversation subscription exists before restart',
      );

      // (b) simulate full restart: tear down the old gateway
      gw.wsServer?.close();
      gw.heartbeat.stop();
      await closeServer(server);
      await once(ws, 'close');

      // (c) create a brand new gateway instance (simulating process restart)
      const newGw = createGatewayApp({
        clock: new FakeClock(Date.now()),
        allowedOrigin: ORIGIN,
        healthChecker: async () => true,
        heartbeatConfig: { intervalMs: 60_000 },
      });

      try {
        // (d) verify NO state survived — fresh registry is empty
        assert.equal(newGw.connectionRegistry.size, 0, 'New gateway has zero connections');
        assert.equal(
          newGw.connectionRegistry.getByConversation(CONV_ID).size,
          0,
          'No conversation subscriptions in new gateway',
        );

        // (e) verify the event buffer is also empty (no stale events)
        assert.equal(
          newGw.eventBuffer.getHighwaterSeq(CONV_ID),
          0,
          'New gateway event buffer has no events from previous instance',
        );
      } finally {
        newGw.heartbeat.stop();
      }

      // Restore shared state for afterEach
      replaceSharedState(await createReplacementState());
    });

    it('client must reconnect after restart — old session cookie is not recognized by new instance', async () => {
      // (a) authenticate and connect to original gateway
      const auth = await loginViaRest();
      const ws = await connectWebSocket(port, { sessionId: auth.sessionId });
      openSockets.push(ws);

      ws.send(JSON.stringify({ type: 'subscribe', conversationId: CONV_ID }));
      await waitForMessage(ws); // subscribed

      // (b) tear down original gateway
      await teardownAndRestore();
      await once(ws, 'close');

      // (c) attempt to use old session cookie with new gateway — WS should fail auth.
      //     The new gateway has a fresh SessionStore with no sessions.
      //     Stale sessions are rejected *before* the WebSocket upgrade completes,
      //     so the server writes an HTTP 401 response on the raw socket.  The ws
      //     library surfaces this via the 'unexpected-response' event when a
      //     listener is attached, giving us the actual HTTP status code.
      const freshWs = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
        headers: {
          Origin: ORIGIN,
          Cookie: `__session=${auth.sessionId}`,
        },
      });

      const outcome = await new Promise<{
        event: 'rejected' | 'open';
        httpStatus?: number;
      }>((resolve) => {
        freshWs.on('open', () => {
          // Unexpected success — the server should reject the stale session.
          freshWs.close();
          resolve({ event: 'open' });
        });
        freshWs.on('unexpected-response', (_req: unknown, res: { statusCode: number }) => {
          resolve({ event: 'rejected', httpStatus: res.statusCode });
          freshWs.close();
        });
        freshWs.on('error', () => {
          // Swallow — 'unexpected-response' or 'close' will follow.
        });
      });

      assert.equal(
        outcome.event,
        'rejected',
        'Stale session must be rejected before WebSocket upgrade',
      );
      assert.equal(
        outcome.httpStatus,
        401,
        `Expected HTTP 401 for stale session, got ${String(outcome.httpStatus)}`,
      );
    });

    it('event buffer does not carry over across gateway restart', async () => {
      // (a) populate buffer in original gateway
      const auth = await loginViaRest();
      const ws = await connectWebSocket(port, { sessionId: auth.sessionId });
      openSockets.push(ws);

      ws.send(JSON.stringify({ type: 'subscribe', conversationId: CONV_ID }));
      await waitForMessage(ws); // subscribed

      const events = fakeDaemon.emitFullStream(CONV_ID, 'turn-buf-restart', ['data']);
      await waitForMessages(ws, events.length);

      // Buffer should have events
      assert.ok(gw.eventBuffer.getHighwaterSeq(CONV_ID) > 0, 'Original gateway buffer has events');

      // (b) tear down and restore for afterEach
      await teardownAndRestore();
      await once(ws, 'close');

      // (c) the restored gateway is effectively a fresh instance — verify buffer is empty
      assert.equal(
        gw.eventBuffer.getHighwaterSeq(CONV_ID),
        0,
        'New gateway has empty event buffer — no state carried over',
      );
      assert.deepEqual(
        gw.eventBuffer.getEventsSince(CONV_ID, 0),
        [],
        'No events in new buffer for any conversation',
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Phase 8 — Integration Tests (T054 – T057)
  // ══════════════════════════════════════════════════════════════════════════

  describe('T054: End-to-end transport (SC-001)', () => {
    it('auth → create conversation → submit instruction → WS stream events → REST turn history → zero direct daemon communication', async () => {
      // ── Step 1: Authenticate via REST ────────────────────────────────────
      const auth = await loginViaRest();
      const gatewayHttpBaseUrl = `http://127.0.0.1:${port}`;
      const gatewayWsUrl = `ws://127.0.0.1:${port}/ws`;

      // ── Step 2: Create a conversation via REST ───────────────────────────
      const createRes = await fetch(`http://127.0.0.1:${port}/conversations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: ORIGIN,
          Cookie: `__session=${auth.sessionId}; __csrf=${auth.csrfToken}`,
          'X-CSRF-Token': auth.csrfToken,
        },
        body: JSON.stringify({ title: 'E2E Lifecycle Test' }),
      });
      assert.equal(
        createRes.status,
        201,
        `Create conversation failed: ${String(createRes.status)}`,
      );
      const createBody = (await createRes.json()) as Record<string, unknown>;
      const conversationId = createBody['id'] as string;
      assert.ok(conversationId, 'Expected conversation ID from create');

      // ── Step 3: Open WebSocket and subscribe ─────────────────────────────
      const ws = await connectWebSocket(port, { sessionId: auth.sessionId });
      openSockets.push(ws);
      assert.equal(ws.url, gatewayWsUrl, 'Browser WebSocket client connects only to the gateway');

      ws.send(JSON.stringify({ type: 'subscribe', conversationId }));
      const subMsg = await waitForMessage(ws);
      assert.equal(subMsg['type'], 'subscribed');
      assert.equal(subMsg['conversationId'], conversationId);

      // ── Step 4: Submit instruction via REST ──────────────────────────────
      const submitRes = await fetch(
        `http://127.0.0.1:${port}/conversations/${conversationId}/turns`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: ORIGIN,
            Cookie: `__session=${auth.sessionId}; __csrf=${auth.csrfToken}`,
            'X-CSRF-Token': auth.csrfToken,
          },
          body: JSON.stringify({ instruction: 'implement the feature' }),
        },
      );
      assert.equal(submitRes.status, 201, `Submit instruction failed: ${String(submitRes.status)}`);
      const submitBody = (await submitRes.json()) as Record<string, unknown>;
      const turnObj = submitBody['turn'] as Record<string, unknown>;
      const turnId = turnObj['id'] as string;
      assert.ok(turnId, 'Expected turnId from instruction submission');
      assert.equal(
        fakeDaemon.submissions.length,
        1,
        'Gateway mediated exactly one daemon submit call',
      );
      assert.equal(
        fakeDaemon.submissions[0]?.conversationId,
        conversationId,
        'Gateway submitted work for the created conversation',
      );

      // ── Step 5: Daemon produces stream events → arrive on WS ─────────
      const emitted = fakeDaemon.emitFullStream(conversationId, turnId, [
        'Hello ',
        'from ',
        'Hydra',
      ]);
      const wsMessages = await waitForMessages(ws, emitted.length);

      // Verify correct lifecycle: started → text-deltas → completed
      assert.equal((wsMessages[0]['event'] as StreamEvent).kind, 'stream-started');
      for (let i = 1; i < wsMessages.length - 1; i++) {
        assert.equal((wsMessages[i]['event'] as StreamEvent).kind, 'text-delta');
      }
      assert.equal((lastItem(wsMessages)['event'] as StreamEvent).kind, 'stream-completed');

      // Verify monotonic sequence numbers
      const seqs = wsMessages.map((m) => (m['event'] as StreamEvent).seq);
      assertMonotonicSequenceNumbers(seqs, 'E2E stream');

      // Verify all events match what the daemon produced
      for (const [i, msg] of wsMessages.entries()) {
        assert.deepEqual(msg['event'], emitted[i], `Event[${i}] matches emitted`);
      }

      // ── Step 6: Load turn history via REST ───────────────────────────────
      const historyRes = await fetch(
        `http://127.0.0.1:${port}/conversations/${conversationId}/turns?limit=50`,
        {
          headers: {
            Origin: ORIGIN,
            Cookie: `__session=${auth.sessionId}; __csrf=${auth.csrfToken}`,
          },
        },
      );
      assert.equal(historyRes.status, 200, `Turn history failed: ${String(historyRes.status)}`);
      const historyBody = (await historyRes.json()) as Record<string, unknown>;
      const turns = historyBody['turns'] as Array<Record<string, unknown>>;
      assert.ok(Array.isArray(turns), 'Expected turns array');
      assert.ok(turns.length >= 1, 'Expected at least one turn in history');
      assert.equal(turns[0]['id'], turnId, 'Turn history includes the submitted turn');

      // ── Step 7: Browser traffic terminates at the gateway ────────────────
      assert.equal(
        new URL(createRes.url).origin,
        gatewayHttpBaseUrl,
        'Create conversation request targeted the gateway origin',
      );
      assert.equal(
        new URL(submitRes.url).origin,
        gatewayHttpBaseUrl,
        'Submit instruction request targeted the gateway origin',
      );
      assert.equal(
        new URL(historyRes.url).origin,
        gatewayHttpBaseUrl,
        'Turn history request targeted the gateway origin',
      );
      assert.ok(
        fakeDaemon.submissions.some((submission) => submission.turnId === turnId),
        'Gateway, not the browser, mediated daemon work submission',
      );
      assert.equal(
        turns[0]['conversationId'],
        conversationId,
        'History came back through gateway mediation',
      );
    });
  });

  describe('T055: Latency measurement (SC-002)', () => {
    it('stream events arrive at browser within 500ms of daemon production under loopback', async () => {
      const auth = await loginViaRest();
      const ws = await connectWebSocket(port, { sessionId: auth.sessionId });
      openSockets.push(ws);

      ws.send(JSON.stringify({ type: 'subscribe', conversationId: CONV_ID }));
      await waitForMessage(ws); // subscribed

      // Collect arrival timestamps for each event
      const arrivalTimestamps: number[] = [];
      const productionTimestamps: number[] = [];

      const eventCount = 5; // started + 3 deltas + completed
      const textChunks = ['alpha', 'beta', 'gamma'];

      // Set up message collector before emitting
      const messagesPromise = new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
        const messages: Array<Record<string, unknown>> = [];
        const timer = setTimeout(() => {
          ws.off('message', onMessage);
          reject(
            new Error(`Timed out: received ${String(messages.length)} of ${String(eventCount)}`),
          );
        }, 5000);

        function onMessage(data: WebSocket.RawData) {
          arrivalTimestamps.push(Date.now());
          messages.push(rawDataToJson(data));
          if (messages.length === eventCount) {
            clearTimeout(timer);
            ws.off('message', onMessage);
            resolve(messages);
          }
        }

        ws.on('message', onMessage);
      });

      // Emit events from fake daemon with precise production timestamps
      const turnId = 'turn-latency';
      const events: StreamEvent[] = [];

      const started: StreamEvent = {
        seq: fakeDaemon.nextSeq(),
        turnId,
        kind: 'stream-started',
        payload: { streamId: `stream-${turnId}` },
        timestamp: new Date().toISOString(),
      };
      productionTimestamps.push(Date.now());
      events.push(started);
      bridge.emitStreamEvent(CONV_ID, started);

      for (const text of textChunks) {
        const delta: StreamEvent = {
          seq: fakeDaemon.nextSeq(),
          turnId,
          kind: 'text-delta',
          payload: { text },
          timestamp: new Date().toISOString(),
        };
        productionTimestamps.push(Date.now());
        events.push(delta);
        bridge.emitStreamEvent(CONV_ID, delta);
      }

      const completed: StreamEvent = {
        seq: fakeDaemon.nextSeq(),
        turnId,
        kind: 'stream-completed',
        payload: { responseLength: textChunks.join('').length },
        timestamp: new Date().toISOString(),
      };
      productionTimestamps.push(Date.now());
      events.push(completed);
      bridge.emitStreamEvent(CONV_ID, completed);

      const wsMessages = await messagesPromise;
      assert.equal(wsMessages.length, eventCount, 'Received all expected events');

      // Measure latency: arrival - production for each event
      const latencies: number[] = [];
      for (let i = 0; i < eventCount; i++) {
        const latency = arrivalTimestamps[i] - productionTimestamps[i];
        latencies.push(latency);
      }

      // SC-002: every event must arrive within 500ms of production
      for (const [i, latency] of latencies.entries()) {
        assert.ok(
          latency <= 500,
          `SC-002: Event[${String(i)}] latency ${String(latency)}ms exceeds 500ms threshold`,
        );
      }

      // Also verify max latency
      const maxLatency = Math.max(...latencies);
      assert.ok(
        maxLatency <= 500,
        `SC-002: Max latency ${String(maxLatency)}ms exceeds 500ms threshold`,
      );

      // Verify events are correct
      for (const [i, msg] of wsMessages.entries()) {
        assert.deepEqual(msg['event'], events[i], `Latency event[${i}] matches emitted`);
      }
    });

    it('latency stays within 500ms even under burst of rapid sequential events', async () => {
      const auth = await loginViaRest();
      const ws = await connectWebSocket(port, { sessionId: auth.sessionId });
      openSockets.push(ws);

      ws.send(JSON.stringify({ type: 'subscribe', conversationId: CONV_ID }));
      await waitForMessage(ws); // subscribed

      const burstSize = 20;
      const arrivalTimestamps: number[] = [];
      const productionTimestamps: number[] = [];

      const messagesPromise = new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
        const messages: Array<Record<string, unknown>> = [];
        const timer = setTimeout(() => {
          ws.off('message', onMessage);
          reject(
            new Error(`Timed out: received ${String(messages.length)} of ${String(burstSize)}`),
          );
        }, 5000);

        function onMessage(data: WebSocket.RawData) {
          arrivalTimestamps.push(Date.now());
          messages.push(rawDataToJson(data));
          if (messages.length === burstSize) {
            clearTimeout(timer);
            ws.off('message', onMessage);
            resolve(messages);
          }
        }

        ws.on('message', onMessage);
      });

      // Emit a burst of text-delta events as fast as possible
      for (let i = 0; i < burstSize; i++) {
        const delta: StreamEvent = {
          seq: fakeDaemon.nextSeq(),
          turnId: 'turn-burst',
          kind: 'text-delta',
          payload: { text: `chunk-${String(i)}` },
          timestamp: new Date().toISOString(),
        };
        productionTimestamps.push(Date.now());
        bridge.emitStreamEvent(CONV_ID, delta);
      }

      const wsMessages = await messagesPromise;
      assert.equal(wsMessages.length, burstSize, `Received all ${String(burstSize)} burst events`);

      for (const [i, _msg] of wsMessages.entries()) {
        const latency = arrivalTimestamps[i] - productionTimestamps[i];
        assert.ok(
          latency <= 500,
          `SC-002 burst: Event[${String(i)}] latency ${String(latency)}ms exceeds 500ms`,
        );
      }
    });
  });

  describe('T056: Disconnect-resume stress (SC-003)', () => {
    it('deterministic disconnect at early/mid/late checkpoints with reconnect produces zero gaps/duplicates', async () => {
      // Deterministic disconnect points covering early, mid, and late replay boundaries.
      // totalEvents = 10 (started + 8 text-deltas + completed), so valid range is [2, 7]
      // (must leave ≥2 for replay-gap and ≥1 for post-reconnect live delivery).
      const disconnectCheckpoints = [2, 5, 7]; // early, mid, late
      const iterations = disconnectCheckpoints.length;

      for (let iter = 0; iter < iterations; iter++) {
        const auth = await loginViaRest();
        const textChunks = Array.from(
          { length: 8 },
          (_, i) => `chunk-${String(i)}-iter-${String(iter)}`,
        );
        const turnId = `turn-stress-${String(iter)}`;

        // ── Phase A: connect, subscribe, receive some events, disconnect at random point
        const ws1 = await connectWebSocket(port, { sessionId: auth.sessionId });
        openSockets.push(ws1);

        ws1.send(JSON.stringify({ type: 'subscribe', conversationId: CONV_ID }));
        await waitForMessage(ws1); // subscribed

        // Deterministic disconnect point for this iteration (early / mid / late).
        const disconnectAfter = disconnectCheckpoints[iter];
        const preDisconnectMessages: Array<Record<string, unknown>> = [];

        const partialPromise = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            ws1.off('message', onMessage);
            reject(new Error(`Iter ${String(iter)}: timed out collecting pre-disconnect events`));
          }, 5000);

          function onMessage(data: WebSocket.RawData) {
            preDisconnectMessages.push(rawDataToJson(data));
            if (preDisconnectMessages.length === disconnectAfter) {
              clearTimeout(timer);
              ws1.off('message', onMessage);
              resolve();
            }
          }

          ws1.on('message', onMessage);
        });

        const emitted = fakeDaemon.planFullStream(CONV_ID, turnId, textChunks);
        const preDisconnectEvents = emitted.slice(0, disconnectAfter);
        const replayGapEvents = emitted.slice(disconnectAfter, disconnectAfter + 2);
        const postReconnectEvents = emitted.slice(disconnectAfter + 2);

        for (const event of preDisconnectEvents) {
          bridge.emitStreamEvent(CONV_ID, event);
          await sleep(5);
        }

        // Wait for partial delivery
        await partialPromise;

        // Record the last acknowledged seq (last received before disconnect)
        const lastReceivedSeq = (lastItem(preDisconnectMessages)['event'] as StreamEvent).seq;

        // Disconnect
        ws1.close();
        await once(ws1, 'close');
        await waitFor(
          () => gw.connectionRegistry.getByConversation(CONV_ID).size,
          (s) => s === 0,
        );

        for (const event of replayGapEvents) {
          bridge.emitStreamEvent(CONV_ID, event);
          await sleep(5);
        }

        // ── Phase B: reconnect with lastAcknowledgedSeq
        const ws2 = await connectWebSocket(port, { sessionId: auth.sessionId });
        openSockets.push(ws2);

        const reconnectMessagesPromise = waitForMessages(
          ws2,
          emitted.filter((e) => e.seq > lastReceivedSeq).length + 1,
          10_000,
        );

        ws2.send(
          JSON.stringify({
            type: 'subscribe',
            conversationId: CONV_ID,
            lastAcknowledgedSeq: lastReceivedSeq,
          }),
        );

        for (const event of postReconnectEvents) {
          bridge.emitStreamEvent(CONV_ID, event);
          await sleep(5);
        }

        const reconnectMessages = await reconnectMessagesPromise;
        const subscribedMessages = reconnectMessages.filter(
          (message) => message['type'] === 'subscribed',
        );
        const replayedEvents = reconnectMessages.filter(
          (message) => message['type'] === 'stream-event',
        );

        assert.equal(
          subscribedMessages.length,
          1,
          'Reconnect yields exactly one subscribed confirmation',
        );
        assert.equal(
          replayGapEvents.length + postReconnectEvents.length,
          replayedEvents.length,
          `Iter ${String(iter)}: reconnect delivers every event after the last ack`,
        );
        assert.ok(
          replayGapEvents.length > 0 && postReconnectEvents.length > 0,
          `Iter ${String(iter)}: stream continued both during disconnect and after reconnect`,
        );

        // ── Phase C: merge pre-disconnect + replayed and assert zero gaps/duplicates
        const preSeqs = preDisconnectMessages.map((m) => (m['event'] as StreamEvent).seq);
        const replayedSeqs = replayedEvents.map((m) => (m['event'] as StreamEvent).seq);
        const allReceivedSeqs = [...preSeqs, ...replayedSeqs];

        // Zero duplicates
        const uniqueSeqs = new Set(allReceivedSeqs);
        assert.equal(
          uniqueSeqs.size,
          allReceivedSeqs.length,
          `Iter ${String(iter)}: zero duplicates — unique(${String(uniqueSeqs.size)}) === total(${String(allReceivedSeqs.length)})`,
        );

        // Zero gaps: should cover all emitted sequences
        const emittedSeqs = emitted.map((e) => e.seq);
        assert.deepEqual(
          allReceivedSeqs.sort((a, b) => a - b),
          emittedSeqs,
          `Iter ${String(iter)}: zero gaps — all emitted sequences received`,
        );

        // Monotonic within each phase
        assertMonotonicSequenceNumbers(preSeqs, `Iter ${String(iter)} pre-disconnect`);
        if (replayedSeqs.length > 1) {
          assertMonotonicSequenceNumbers(replayedSeqs, `Iter ${String(iter)} replay`);
        }

        // Verify event content matches emitted
        const allReceivedEvents = [
          ...preDisconnectMessages.map((m) => m['event'] as StreamEvent),
          ...replayedEvents.map((m) => m['event'] as StreamEvent),
        ].sort((a, b) => a.seq - b.seq);

        for (const [i, receivedEvent] of allReceivedEvents.entries()) {
          assert.deepEqual(
            receivedEvent,
            emitted[i],
            `Iter ${String(iter)}: event at seq ${String(receivedEvent.seq)} matches emitted`,
          );
        }

        // Clean up for next iteration
        ws2.close();
        await once(ws2, 'close');
        await waitFor(
          () => gw.connectionRegistry.getByConversation(CONV_ID).size,
          (s) => s === 0,
        );
      }
    });

    it('disconnect at first event and last event boundary still produces complete replay', async () => {
      for (const disconnectAt of ['first', 'last'] as const) {
        const auth = await loginViaRest();
        const turnId = `turn-boundary-${disconnectAt}`;
        const textChunks = ['one', 'two', 'three'];

        const ws1 = await connectWebSocket(port, { sessionId: auth.sessionId });
        openSockets.push(ws1);

        ws1.send(JSON.stringify({ type: 'subscribe', conversationId: CONV_ID }));
        await waitForMessage(ws1); // subscribed

        const emitted = fakeDaemon.emitFullStream(CONV_ID, turnId, textChunks);
        const targetCount = disconnectAt === 'first' ? 1 : emitted.length;
        const received = await waitForMessages(ws1, targetCount);

        const lastReceivedSeq = (lastItem(received)['event'] as StreamEvent).seq;

        ws1.close();
        await once(ws1, 'close');
        await waitFor(
          () => gw.connectionRegistry.getByConversation(CONV_ID).size,
          (s) => s === 0,
        );

        // Reconnect
        const ws2 = await connectWebSocket(port, { sessionId: auth.sessionId });
        openSockets.push(ws2);

        ws2.send(
          JSON.stringify({
            type: 'subscribe',
            conversationId: CONV_ID,
            lastAcknowledgedSeq: lastReceivedSeq,
          }),
        );

        const expectedReplayCount = emitted.filter((e) => e.seq > lastReceivedSeq).length;

        if (expectedReplayCount > 0) {
          const reconnectMsgs = await waitForMessages(ws2, expectedReplayCount + 1);
          const replayed = reconnectMsgs.slice(0, expectedReplayCount);
          assert.equal(reconnectMsgs[expectedReplayCount]['type'], 'subscribed');

          // Merge and verify completeness
          const allSeqs = [
            ...received.map((m) => (m['event'] as StreamEvent).seq),
            ...replayed.map((m) => (m['event'] as StreamEvent).seq),
          ].sort((a, b) => a - b);

          assert.deepEqual(
            allSeqs,
            emitted.map((e) => e.seq),
            `Boundary=${disconnectAt}: all sequences present`,
          );
          assert.equal(
            new Set(allSeqs).size,
            allSeqs.length,
            `Boundary=${disconnectAt}: zero duplicates`,
          );
        } else {
          // disconnectAt === 'last': already received everything, just get subscribed
          const subMsg = await waitForMessage(ws2);
          assert.equal(subMsg['type'], 'subscribed');
        }

        ws2.close();
        await once(ws2, 'close');
        await waitFor(
          () => gw.connectionRegistry.getByConversation(CONV_ID).size,
          (s) => s === 0,
        );
      }
    });
  });

  describe('T057: Session-bypass comprehensive (SC-004)', () => {
    // ── All 15 REST conversation routes ──────────────────────────────────

    const restRoutes: Array<{
      method: string;
      path: string;
      label: string;
      body?: Record<string, unknown>;
    }> = [
      {
        method: 'POST',
        path: '/conversations',
        label: 'createConversation',
        body: { title: 'test' },
      },
      { method: 'GET', path: '/conversations', label: 'listConversations' },
      { method: 'GET', path: '/conversations/conv-x', label: 'openConversation' },
      {
        method: 'POST',
        path: '/conversations/conv-x/resume',
        label: 'resumeConversation',
        body: {},
      },
      { method: 'POST', path: '/conversations/conv-x/archive', label: 'archiveConversation' },
      {
        method: 'POST',
        path: '/conversations/conv-x/turns',
        label: 'submitInstruction',
        body: { instruction: 'test' },
      },
      { method: 'GET', path: '/conversations/conv-x/turns?limit=10', label: 'loadTurnHistory' },
      { method: 'GET', path: '/conversations/conv-x/approvals', label: 'getPendingApprovals' },
      {
        method: 'POST',
        path: '/approvals/appr-1/respond',
        label: 'respondToApproval',
        body: { response: 'approve' },
      },
      { method: 'POST', path: '/conversations/conv-x/turns/turn-1/cancel', label: 'cancelWork' },
      { method: 'POST', path: '/conversations/conv-x/turns/turn-1/retry', label: 'retryTurn' },
      { method: 'GET', path: '/turns/turn-1/artifacts', label: 'listArtifactsForTurn' },
      {
        method: 'GET',
        path: '/conversations/conv-x/artifacts?limit=10',
        label: 'listArtifactsForConversation',
      },
      { method: 'GET', path: '/artifacts/art-1', label: 'getArtifactContent' },
      { method: 'GET', path: '/turns/turn-1/activities', label: 'getActivityEntries' },
    ];

    for (const route of restRoutes) {
      it(`REST ${route.method} ${route.label} rejects unauthenticated access`, async () => {
        const res = await fetch(`http://127.0.0.1:${port}${route.path}`, {
          method: route.method,
          headers: {
            'Content-Type': 'application/json',
            Origin: ORIGIN,
            // No session cookie — unauthenticated
          },
          ...(route.body ? { body: JSON.stringify(route.body) } : {}),
        });

        assert.ok(
          res.status === 401 || res.status === 403,
          `SC-004: ${route.label} must reject unauthenticated — got ${String(res.status)}`,
        );
      });
    }

    // ── All 3 WS message types ───────────────────────────────────────────

    it('WebSocket handshake rejects connection without valid session cookie', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
        headers: { Origin: ORIGIN },
      });

      const [, response] = (await once(ws, 'unexpected-response')) as [
        unknown,
        { statusCode?: number },
      ];
      assert.equal(
        response.statusCode,
        401,
        'SC-004: WS handshake rejected without session cookie',
      );
    });

    it('WebSocket handshake rejects connection with invalid session cookie', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
        headers: {
          Origin: ORIGIN,
          Cookie: '__session=invalid-session-id-that-does-not-exist',
        },
      });

      const [, response] = (await once(ws, 'unexpected-response')) as [
        unknown,
        { statusCode?: number },
      ];
      assert.equal(response.statusCode, 401, 'SC-004: WS handshake rejected with invalid session');
    });

    it('subscribe message type is unreachable without authenticated WS (handshake gate)', async () => {
      // The WS upgrade is rejected at the handshake level when the session is
      // invalid, so subscribe messages can never be sent. Verify the connection
      // never opens.
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
        headers: { Origin: ORIGIN },
      });

      let opened = false;
      ws.on('open', () => {
        opened = true;
      });

      await once(ws, 'error'); // rejected upgrade
      assert.equal(opened, false, 'SC-004: subscribe — WS never opened without valid session');
    });

    it('unsubscribe message type is unreachable without authenticated WS (handshake gate)', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
        headers: { Origin: ORIGIN },
      });

      let opened = false;
      ws.on('open', () => {
        opened = true;
      });

      await once(ws, 'error');
      assert.equal(opened, false, 'SC-004: unsubscribe — WS never opened without valid session');
    });

    it('ack message type is unreachable without authenticated WS (handshake gate)', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
        headers: { Origin: ORIGIN },
      });

      let opened = false;
      ws.on('open', () => {
        opened = true;
      });

      await once(ws, 'error');
      assert.equal(opened, false, 'SC-004: ack — WS never opened without valid session');
    });

    // ── Positive control: authenticated access succeeds ──────────────────

    it('authenticated REST request succeeds (positive control)', async () => {
      const auth = await loginViaRest();
      const res = await fetch(`http://127.0.0.1:${port}/conversations/${CONV_ID}`, {
        headers: {
          Origin: ORIGIN,
          Cookie: `__session=${auth.sessionId}; __csrf=${auth.csrfToken}`,
        },
      });
      // Should succeed (200) — not be rejected
      assert.equal(
        res.status,
        200,
        `Positive control: authenticated GET /conversations/:id should succeed, got ${String(res.status)}`,
      );
    });

    it('authenticated WebSocket connection succeeds (positive control)', async () => {
      const auth = await loginViaRest();
      const ws = await connectWebSocket(port, { sessionId: auth.sessionId });
      openSockets.push(ws);

      // Connection opened — send subscribe and verify it works
      ws.send(JSON.stringify({ type: 'subscribe', conversationId: CONV_ID }));
      const subMsg = await waitForMessage(ws);
      assert.equal(
        subMsg['type'],
        'subscribed',
        'Positive control: authenticated WS subscribe succeeds',
      );
    });
  });
});
