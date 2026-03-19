import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { WsConnection } from '../ws-connection.ts';
import { ConnectionRegistry } from '../connection-registry.ts';
import { SessionWsBridge } from '../session-ws-bridge.ts';
import { SessionStateBroadcaster } from '../../session/session-state-broadcaster.ts';
import { SessionStore } from '../../session/session-store.ts';
import { SessionService } from '../../session/session-service.ts';
import { DaemonHeartbeat, type HealthChecker } from '../../session/daemon-heartbeat.ts';
import { FakeClock } from '../../shared/clock.ts';
import type { StoredSession } from '../../session/session-store.ts';
import type { ServerMessage } from '../ws-protocol.ts';

/** Minimal fake WebSocket for testing (mirrors ws.WebSocket surface we use). */
function fakeSocket() {
  const sent: string[] = [];
  let closeCode: number | undefined;
  let closeReason: string | undefined;
  let readyState = 1; // OPEN
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  return {
    sent,
    get readyState() {
      return readyState;
    },
    set readyState(v: number) {
      readyState = v;
    },
    get closeCode() {
      return closeCode;
    },
    get closeReason() {
      return closeReason;
    },
    get bufferedAmount() {
      return 0;
    },
    send(data: string) {
      sent.push(data);
    },
    terminate() {
      readyState = 3;
      const handlers = listeners.get('close') ?? [];
      for (const h of handlers) h();
    },
    close(code?: number, reason?: string) {
      closeCode = code;
      closeReason = reason;
      readyState = 3; // CLOSED
      // Fire close listeners
      const handlers = listeners.get('close') ?? [];
      for (const h of handlers) h(code, reason);
    },
    on(event: string, handler: (...args: unknown[]) => void) {
      let handlers = listeners.get(event);
      if (!handlers) {
        handlers = [];
        listeners.set(event, handlers);
      }
      handlers.push(handler);
    },
    emit(event: string, ...args: unknown[]) {
      const handlers = listeners.get(event) ?? [];
      for (const handler of handlers) {
        handler(...args);
      }
    },
    removeAllListeners() {
      listeners.clear();
    },
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3,
  };
}

/** Parse sent raw JSON strings from a fake socket into ServerMessage objects. */
function parseSent(ws: ReturnType<typeof fakeSocket>): ServerMessage[] {
  return ws.sent.map((raw) => JSON.parse(raw) as ServerMessage);
}

describe('WsConnection', () => {
  let registry: ConnectionRegistry;

  beforeEach(() => {
    registry = new ConnectionRegistry();
  });

  // ─── creation ──────────────────────────────────────────────────────────

  describe('creation', () => {
    it('generates a unique connectionId', () => {
      const ws1 = fakeSocket();
      const ws2 = fakeSocket();
      const c1 = WsConnection.create('s1', ws1 as never, registry);
      const c2 = WsConnection.create('s1', ws2 as never, registry);
      assert.notEqual(c1.connectionId, c2.connectionId);
      assert.match(c1.connectionId, /^[0-9a-f-]{36}$/);
    });

    it('binds sessionId immutably', () => {
      const ws = fakeSocket();
      const conn = WsConnection.create('s1', ws as never, registry);
      assert.equal(conn.sessionId, 's1');
    });

    it('starts in open state', () => {
      const ws = fakeSocket();
      const conn = WsConnection.create('s1', ws as never, registry);
      assert.equal(conn.state, 'open');
    });

    it('registers itself in the registry', () => {
      const ws = fakeSocket();
      const conn = WsConnection.create('s1', ws as never, registry);
      const bySession = registry.getBySession('s1');
      assert.equal(bySession.size, 1);
      assert.ok([...bySession][0].connectionId === conn.connectionId);
    });

    it('starts with empty subscribedConversations', () => {
      const ws = fakeSocket();
      const conn = WsConnection.create('s1', ws as never, registry);
      assert.equal(conn.subscribedConversations.size, 0);
    });

    it('starts with empty lastAckSeq map', () => {
      const ws = fakeSocket();
      const conn = WsConnection.create('s1', ws as never, registry);
      assert.equal(conn.lastAckSeq.size, 0);
    });

    it('starts with replay-ready state containers', () => {
      const ws = fakeSocket();
      const conn = WsConnection.create('s1', ws as never, registry);
      assert.equal(conn.replayState.size, 0);
      assert.equal(conn.pendingEvents.size, 0);
    });
  });

  // ─── session binding immutability ──────────────────────────────────────

  describe('session binding immutability', () => {
    it('sessionId cannot be reassigned', () => {
      const ws = fakeSocket();
      const conn = WsConnection.create('s1', ws as never, registry);
      // TypeScript prevents assignment at compile time; verify at runtime
      assert.throws(() => {
        (conn as unknown as Record<string, unknown>)['sessionId'] = 's2';
      });
    });
  });

  // ─── state transitions ────────────────────────────────────────────────

  describe('state transitions', () => {
    it('open → closing → closed on close()', () => {
      // The fake socket fires close synchronously, so we observe the final state
      const ws = fakeSocket();
      const conn = WsConnection.create('s1', ws as never, registry);
      conn.close(1000, 'normal');
      // After close + socket close event: fully closed
      assert.equal(conn.state, 'closed');
    });

    it('transitions through closing before closed', () => {
      // Use a socket that does NOT auto-fire close to observe intermediate state
      const ws = fakeSocket();
      const originalClose = ws.close.bind(ws);
      // Override close to not fire listeners (simulates async close)
      ws.close = (code?: number, reason?: string) => {
        ws.readyState = 2; // CLOSING
        // Don't fire listeners yet
        void code;
        void reason;
      };
      const conn = WsConnection.create('s1', ws as never, registry);
      conn.close(1000, 'normal');
      assert.equal(conn.state, 'closing');

      // Now simulate the socket actually closing
      ws.close = originalClose;
      ws.close(1000, 'normal');
      assert.equal(conn.state, 'closed');
    });

    it('double close is a no-op', () => {
      const ws = fakeSocket();
      const conn = WsConnection.create('s1', ws as never, registry);
      conn.close(1000, 'normal');
      assert.doesNotThrow(() => {
        conn.close(1000, 'again');
      });
    });

    it('isClosed returns true after close', () => {
      const ws = fakeSocket();
      const conn = WsConnection.create('s1', ws as never, registry);
      assert.equal(conn.isClosed, false);
      conn.close(1000, 'normal');
      assert.equal(conn.isClosed, true);
    });
  });

  // ─── send ──────────────────────────────────────────────────────────────

  describe('send', () => {
    it('sends serialized server message to the socket', () => {
      const ws = fakeSocket();
      const conn = WsConnection.create('s1', ws as never, registry);
      conn.send({ type: 'daemon-restored' });
      assert.equal(ws.sent.length, 1);
      const parsed = JSON.parse(ws.sent[0]);
      assert.equal(parsed.type, 'daemon-restored');
    });

    it('does not send if connection is closed', () => {
      const ws = fakeSocket();
      const conn = WsConnection.create('s1', ws as never, registry);
      conn.close(1000, 'done');
      conn.send({ type: 'daemon-restored' });
      // The close itself doesn't send via our send() method, so sent should be empty
      assert.equal(ws.sent.length, 0);
    });
  });

  // ─── ack tracking ─────────────────────────────────────────────────────

  describe('ack tracking', () => {
    it('updateAck stores last acknowledged seq per conversation', () => {
      const ws = fakeSocket();
      const conn = WsConnection.create('s1', ws as never, registry);
      conn.updateAck('conv-1', 5);
      assert.equal(conn.lastAckSeq.get('conv-1'), 5);
    });

    it('updateAck only advances (never decrements)', () => {
      const ws = fakeSocket();
      const conn = WsConnection.create('s1', ws as never, registry);
      conn.updateAck('conv-1', 10);
      conn.updateAck('conv-1', 3);
      assert.equal(conn.lastAckSeq.get('conv-1'), 10);
    });
  });

  // ─── close cleanup ────────────────────────────────────────────────────

  describe('close cleanup', () => {
    it('unregisters from registry on close', () => {
      const ws = fakeSocket();
      const conn = WsConnection.create('s1', ws as never, registry);
      registry.addSubscription(conn.connectionId, 'conv-1');
      conn.close(1000, 'bye');
      assert.equal(registry.getBySession('s1').size, 0);
      assert.equal(registry.getByConversation('conv-1').size, 0);
    });
  });

  // ─── external close (socket drops) ────────────────────────────────────

  describe('external socket close', () => {
    it('transitions to closed and unregisters on unexpected socket close', () => {
      const ws = fakeSocket();
      const conn = WsConnection.create('s1', ws as never, registry);

      // Simulate external socket close (e.g., network drop)
      ws.close(1006, 'abnormal');

      assert.equal(conn.state, 'closed');
      assert.equal(registry.getBySession('s1').size, 0);
    });

    it('preserves external close listeners registered after creation', () => {
      const ws = fakeSocket();
      WsConnection.create('s1', ws as never, registry);
      let externalCloseCalls = 0;

      ws.on('close', () => {
        externalCloseCalls += 1;
      });

      ws.close(1000, 'normal');

      assert.equal(externalCloseCalls, 1);
    });

    it('cleans up on socket error without throwing uncaught', () => {
      const ws = fakeSocket();
      const conn = WsConnection.create('s1', ws as never, registry);
      assert.doesNotThrow(() => {
        ws.emit('error', new Error('boom'));
      });
      assert.equal(conn.state, 'closed');
      assert.equal(registry.getBySession('s1').size, 0);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// T044 — Daemon unavailable / restored: end-to-end WebSocket path
// Validates the full chain: DaemonHeartbeat.tick() → SessionService →
//   SessionStateBroadcaster → SessionWsBridge → WsConnection.send()
// ═══════════════════════════════════════════════════════════════════════════════

describe('T044: daemon unavailable — WebSocket path', () => {
  let clock: FakeClock;
  let store: SessionStore;
  let broadcaster: SessionStateBroadcaster;
  let sessionService: SessionService;
  let registry: ConnectionRegistry;
  let bridge: SessionWsBridge;
  let session: StoredSession;

  /** Controllable health checker for DaemonHeartbeat. */
  let healthResult: boolean;
  const healthChecker: HealthChecker = async () => healthResult;

  beforeEach(async () => {
    clock = new FakeClock(1_000_000);
    store = new SessionStore();
    broadcaster = new SessionStateBroadcaster();
    sessionService = new SessionService(store, clock, {}, undefined, broadcaster);
    registry = new ConnectionRegistry();
    bridge = new SessionWsBridge({ broadcaster, registry, clock });
    healthResult = true;

    session = await sessionService.create('op-1', '127.0.0.1');
  });

  function connectAndBind(): { ws: ReturnType<typeof fakeSocket>; conn: WsConnection; cleanup: () => void } {
    const ws = fakeSocket();
    const conn = WsConnection.create(session.id, ws as never, registry);
    const cleanup = bridge.bindSession(session, conn as never);
    return { ws, conn, cleanup };
  }

  it('delivers daemon-unavailable through the full heartbeat → WS chain', async () => {
    const { ws, conn, cleanup } = connectAndBind();

    const heartbeat = new DaemonHeartbeat(sessionService, store, healthChecker, {
      intervalMs: 60_000,
      daemonUrl: 'http://localhost:0',
    });

    try {
      // Daemon goes down
      healthResult = false;
      await heartbeat.tick();

      const messages = parseSent(ws);
      assert.ok(
        messages.some((m) => m.type === 'daemon-unavailable'),
        'Expected daemon-unavailable message on the WebSocket',
      );
      assert.equal(conn.state, 'open', 'Connection must stay open during grace period');
    } finally {
      cleanup();
      heartbeat.stop();
    }
  });

  it('delivers daemon-restored after recovery through the full chain', async () => {
    const { ws, conn, cleanup } = connectAndBind();

    const heartbeat = new DaemonHeartbeat(sessionService, store, healthChecker, {
      intervalMs: 60_000,
      daemonUrl: 'http://localhost:0',
    });

    try {
      // Daemon goes down
      healthResult = false;
      await heartbeat.tick();

      // Daemon recovers
      healthResult = true;
      await heartbeat.tick();

      const messages = parseSent(ws);
      const types = messages.map((m) => m.type);

      assert.ok(types.includes('daemon-unavailable'), 'Expected daemon-unavailable before recovery');
      assert.ok(types.includes('daemon-restored'), 'Expected daemon-restored after recovery');
      assert.equal(conn.state, 'open', 'Connection must stay open after recovery');
    } finally {
      cleanup();
      heartbeat.stop();
    }
  });

  it('connection stays open throughout the grace period (no close during daemon-unreachable)', async () => {
    const { ws, conn, cleanup } = connectAndBind();

    const heartbeat = new DaemonHeartbeat(sessionService, store, healthChecker, {
      intervalMs: 60_000,
      daemonUrl: 'http://localhost:0',
    });

    try {
      healthResult = false;
      await heartbeat.tick();

      // Tick again while still down — still no close
      await heartbeat.tick();

      assert.equal(conn.state, 'open', 'Connection must remain open during daemon outage');
      assert.equal(ws.readyState, 1, 'Socket must remain in OPEN readyState');
    } finally {
      cleanup();
      heartbeat.stop();
    }
  });

  it('multiple connections on the same session all receive daemon-unavailable', async () => {
    const conn1 = connectAndBind();
    const conn2 = connectAndBind();

    const heartbeat = new DaemonHeartbeat(sessionService, store, healthChecker, {
      intervalMs: 60_000,
      daemonUrl: 'http://localhost:0',
    });

    try {
      healthResult = false;
      await heartbeat.tick();

      const msgs1 = parseSent(conn1.ws);
      const msgs2 = parseSent(conn2.ws);

      assert.ok(
        msgs1.some((m) => m.type === 'daemon-unavailable'),
        'Connection 1 should receive daemon-unavailable',
      );
      assert.ok(
        msgs2.some((m) => m.type === 'daemon-unavailable'),
        'Connection 2 should receive daemon-unavailable',
      );
    } finally {
      conn1.cleanup();
      conn2.cleanup();
      heartbeat.stop();
    }
  });

  it('multiple connections on the same session all receive daemon-restored', async () => {
    const conn1 = connectAndBind();
    const conn2 = connectAndBind();

    const heartbeat = new DaemonHeartbeat(sessionService, store, healthChecker, {
      intervalMs: 60_000,
      daemonUrl: 'http://localhost:0',
    });

    try {
      healthResult = false;
      await heartbeat.tick();
      healthResult = true;
      await heartbeat.tick();

      const msgs1 = parseSent(conn1.ws);
      const msgs2 = parseSent(conn2.ws);

      assert.ok(msgs1.some((m) => m.type === 'daemon-restored'), 'Connection 1 should receive daemon-restored');
      assert.ok(msgs2.some((m) => m.type === 'daemon-restored'), 'Connection 2 should receive daemon-restored');
    } finally {
      conn1.cleanup();
      conn2.cleanup();
      heartbeat.stop();
    }
  });

  it('daemon-restored is only sent after a preceding daemon-unavailable', async () => {
    const { ws, cleanup } = connectAndBind();

    const heartbeat = new DaemonHeartbeat(sessionService, store, healthChecker, {
      intervalMs: 60_000,
      daemonUrl: 'http://localhost:0',
    });

    try {
      // Daemon stays healthy — tick should produce no messages
      healthResult = true;
      await heartbeat.tick();

      const messages = parseSent(ws);
      assert.ok(
        !messages.some((m) => m.type === 'daemon-restored'),
        'Should not send daemon-restored when daemon was never down',
      );
      assert.ok(
        !messages.some((m) => m.type === 'daemon-unavailable'),
        'Should not send daemon-unavailable when daemon is healthy',
      );
    } finally {
      cleanup();
      heartbeat.stop();
    }
  });

  it('daemon down/up cycle ordering: unavailable precedes restored', async () => {
    const { ws, cleanup } = connectAndBind();

    const heartbeat = new DaemonHeartbeat(sessionService, store, healthChecker, {
      intervalMs: 60_000,
      daemonUrl: 'http://localhost:0',
    });

    try {
      healthResult = false;
      await heartbeat.tick();
      healthResult = true;
      await heartbeat.tick();

      const messages = parseSent(ws);
      const unavailableIdx = messages.findIndex((m) => m.type === 'daemon-unavailable');
      const restoredIdx = messages.findIndex((m) => m.type === 'daemon-restored');

      assert.ok(unavailableIdx >= 0, 'daemon-unavailable must be present');
      assert.ok(restoredIdx >= 0, 'daemon-restored must be present');
      assert.ok(
        unavailableIdx < restoredIdx,
        `daemon-unavailable (idx ${unavailableIdx}) must arrive before daemon-restored (idx ${restoredIdx})`,
      );
    } finally {
      cleanup();
      heartbeat.stop();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// T050 — Idle WebSocket connection (no subscriptions)
// Validates: connection stays alive, receives lifecycle notifications,
//   receives no stream events.
// ═══════════════════════════════════════════════════════════════════════════════

describe('T050: idle WebSocket connection — no subscriptions', () => {
  let clock: FakeClock;
  let store: SessionStore;
  let broadcaster: SessionStateBroadcaster;
  let sessionService: SessionService;
  let registry: ConnectionRegistry;
  let bridge: SessionWsBridge;
  let session: StoredSession;

  beforeEach(async () => {
    clock = new FakeClock(1_000_000);
    store = new SessionStore();
    broadcaster = new SessionStateBroadcaster();
    sessionService = new SessionService(store, clock, {}, undefined, broadcaster);
    registry = new ConnectionRegistry();
    bridge = new SessionWsBridge({ broadcaster, registry, clock });

    session = await sessionService.create('op-1', '127.0.0.1');
  });

  function connectIdle(): { ws: ReturnType<typeof fakeSocket>; conn: WsConnection; cleanup: () => void } {
    const ws = fakeSocket();
    const conn = WsConnection.create(session.id, ws as never, registry);
    const cleanup = bridge.bindSession(session, conn as never);
    // Deliberately send NO subscribe messages — this is the "idle" condition
    return { ws, conn, cleanup };
  }

  it('idle connection stays open and valid', () => {
    const { conn, cleanup } = connectIdle();

    try {
      assert.equal(conn.state, 'open');
      assert.equal(conn.isClosed, false);
      assert.equal(conn.subscribedConversations.size, 0, 'No subscriptions on idle connection');
    } finally {
      cleanup();
    }
  });

  it('idle connection receives session-expiring-soon notification', () => {
    const { ws, conn, cleanup } = connectIdle();

    try {
      const nearExpiry = new Date(clock.now() + 5_000).toISOString();
      broadcaster.broadcast(session.id, {
        type: 'state-change',
        previousState: 'active',
        newState: 'expiring-soon',
        expiresAt: nearExpiry,
      });

      const messages = parseSent(ws);
      assert.ok(
        messages.some((m) => m.type === 'session-expiring-soon'),
        'Idle connection should receive session-expiring-soon',
      );
      assert.equal(conn.state, 'open', 'Connection should stay open after expiring-soon');
    } finally {
      cleanup();
    }
  });

  it('idle connection receives daemon-unavailable notification', async () => {
    const { ws, conn, cleanup } = connectIdle();

    const healthChecker: HealthChecker = async () => false;
    const heartbeat = new DaemonHeartbeat(sessionService, store, healthChecker, {
      intervalMs: 60_000,
      daemonUrl: 'http://localhost:0',
    });

    try {
      await heartbeat.tick();

      const messages = parseSent(ws);
      assert.ok(
        messages.some((m) => m.type === 'daemon-unavailable'),
        'Idle connection should receive daemon-unavailable',
      );
      assert.equal(conn.state, 'open', 'Idle connection stays open during daemon outage');
    } finally {
      cleanup();
      heartbeat.stop();
    }
  });

  it('idle connection receives daemon-restored after recovery', async () => {
    const { ws, conn, cleanup } = connectIdle();

    let healthy = true;
    const healthChecker: HealthChecker = async () => healthy;
    const heartbeat = new DaemonHeartbeat(sessionService, store, healthChecker, {
      intervalMs: 60_000,
      daemonUrl: 'http://localhost:0',
    });

    try {
      healthy = false;
      await heartbeat.tick();
      healthy = true;
      await heartbeat.tick();

      const messages = parseSent(ws);
      assert.ok(messages.some((m) => m.type === 'daemon-unavailable'), 'Should receive daemon-unavailable');
      assert.ok(messages.some((m) => m.type === 'daemon-restored'), 'Should receive daemon-restored');
      assert.equal(conn.state, 'open', 'Idle connection stays open after recovery');
    } finally {
      cleanup();
      heartbeat.stop();
    }
  });

  it('idle connection does not receive stream-event messages', async () => {
    const { ws, conn, cleanup } = connectIdle();

    try {
      // Directly send a stream-event to the connection as if the forwarder would —
      // but verify the connection has no subscriptions, so the forwarder would never
      // target it. The registry query for a conversation must not include this connection.
      assert.equal(conn.subscribedConversations.size, 0, 'No subscriptions');
      assert.equal(conn.pendingConversations.size, 0, 'No pending conversations');
      assert.equal(
        registry.getByConversation('any-conv').size,
        0,
        'Registry has no conversation subscriptions for idle connection',
      );

      const messages = parseSent(ws);
      assert.ok(
        !messages.some((m) => m.type === 'stream-event'),
        'Idle connection must not receive stream events',
      );
    } finally {
      cleanup();
    }
  });

  it('idle connection with lifecycle notifications still has no stream events', async () => {
    const { ws, conn, cleanup } = connectIdle();

    let healthy = true;
    const healthChecker: HealthChecker = async () => healthy;
    const heartbeat = new DaemonHeartbeat(sessionService, store, healthChecker, {
      intervalMs: 60_000,
      daemonUrl: 'http://localhost:0',
    });

    try {
      // Trigger daemon down then up → lifecycle messages arrive
      healthy = false;
      await heartbeat.tick();
      healthy = true;
      await heartbeat.tick();

      // Also trigger expiring-soon
      const nearExpiry = new Date(clock.now() + 5_000).toISOString();
      broadcaster.broadcast(session.id, {
        type: 'state-change',
        previousState: 'active',
        newState: 'expiring-soon',
        expiresAt: nearExpiry,
      });

      const messages = parseSent(ws);

      // Should have lifecycle messages
      assert.ok(messages.some((m) => m.type === 'daemon-unavailable'), 'daemon-unavailable received');
      assert.ok(messages.some((m) => m.type === 'daemon-restored'), 'daemon-restored received');
      assert.ok(messages.some((m) => m.type === 'session-expiring-soon'), 'session-expiring-soon received');

      // Must NOT have stream events
      assert.ok(
        !messages.some((m) => m.type === 'stream-event'),
        'Idle connection must not receive stream events even after lifecycle notifications',
      );

      assert.equal(conn.state, 'open', 'Connection stays open throughout');
      assert.equal(conn.subscribedConversations.size, 0, 'Still no subscriptions');
    } finally {
      cleanup();
      heartbeat.stop();
    }
  });

  it('idle connection is still functional and can later accept subscriptions', () => {
    const { conn, cleanup } = connectIdle();

    try {
      assert.equal(conn.state, 'open');
      assert.equal(conn.subscribedConversations.size, 0);

      // Simulate what would happen when a subscribe succeeds (registry-level)
      registry.addSubscription(conn.connectionId, 'conv-later');
      assert.equal(conn.subscribedConversations.size, 1, 'Can add subscriptions to previously idle connection');
      assert.ok(
        registry.getByConversation('conv-later').size === 1,
        'Registry reflects the new subscription',
      );
    } finally {
      cleanup();
    }
  });
});
