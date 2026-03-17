import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock } from '../../shared/clock.ts';
import { SessionStateBroadcaster } from '../../session/session-state-broadcaster.ts';
import { ConnectionRegistry } from '../connection-registry.ts';
import { SessionWsBridge } from '../session-ws-bridge.ts';
import type { StoredSession } from '../../session/session-store.ts';
import type { ManagedConnection } from '../connection-registry.ts';
import type { ServerMessage } from '../ws-protocol.ts';

function createMockConnection(sessionId: string): ManagedConnection & { sent: ServerMessage[] } {
  const sent: ServerMessage[] = [];
  let closed = false;
  return {
    connectionId: `conn-${Math.random().toString(36).slice(2, 8)}`,
    sessionId,
    subscribedConversations: new Set(),
    lastAckSeq: new Map(),
    replayState: new Map(),
    pendingEvents: new Map(),
    sent,
    send(msg: ServerMessage) {
      sent.push(msg);
    },
    updateAck() {},
    close() {
      closed = true;
    },
    get isClosed() {
      return closed;
    },
  };
}

function createSession(overrides: Partial<StoredSession> = {}): StoredSession {
  const now = new Date().toISOString();
  return {
    id: 'sess-1',
    operatorId: 'op-1',
    state: 'active',
    createdAt: now,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    lastActivityAt: now,
    extendedCount: 0,
    invalidatedReason: null,
    createdFromIp: '127.0.0.1',
    csrfToken: 'csrf-tok',
    ...overrides,
  };
}

describe('SessionWsBridge', () => {
  let clock: FakeClock;
  let broadcaster: SessionStateBroadcaster;
  let registry: ConnectionRegistry;
  let bridge: SessionWsBridge;

  beforeEach(() => {
    clock = new FakeClock(1_000_000);
    broadcaster = new SessionStateBroadcaster();
    registry = new ConnectionRegistry();
    bridge = new SessionWsBridge({ broadcaster, registry, clock });
  });

  describe('scheduleExpiry with Clock', () => {
    it('uses the injected clock for delay calculation', async () => {
      // Session expires 500ms from clock.now()
      const expiresAt = new Date(clock.now() + 500).toISOString();
      const session = createSession({ expiresAt });
      const conn = createMockConnection(session.id);
      registry.register(conn);

      const cleanup = bridge.bindSession(session, conn as never);

      // Advance clock past expiry — setTimeout still fires on real time,
      // so we verify the timer was set by waiting for the message
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 600);
      });

      assert.ok(
        conn.sent.some((m) => m.type === 'session-terminated'),
        'Expected session-terminated message after expiry',
      );
      cleanup();
    });

    it('terminates immediately when expiresAt is already past clock.now()', () => {
      const expiresAt = new Date(clock.now() - 1000).toISOString();
      const session = createSession({ expiresAt });
      const conn = createMockConnection(session.id);
      registry.register(conn);

      const cleanup = bridge.bindSession(session, conn as never);

      const terminated = conn.sent.find((m) => m.type === 'session-terminated');
      assert.ok(terminated, 'Expected immediate session-terminated');
      cleanup();
    });
  });

  describe('invalid expiresAt handling', () => {
    it('ignores invalid date strings without scheduling a timer', () => {
      const session = createSession({ expiresAt: 'not-a-date' });
      const conn = createMockConnection(session.id);
      registry.register(conn);

      const cleanup = bridge.bindSession(session, conn as never);

      // No termination message should be sent for invalid dates
      assert.equal(conn.sent.length, 0, 'No messages should be sent for invalid expiresAt');
      cleanup();
    });

    it('ignores empty expiresAt string', () => {
      const session = createSession({ expiresAt: '' });
      const conn = createMockConnection(session.id);
      registry.register(conn);

      const cleanup = bridge.bindSession(session, conn as never);
      assert.equal(conn.sent.length, 0);
      cleanup();
    });
  });

  describe('broadcaster events', () => {
    it('reschedules expiry on expiring-soon event using clock', () => {
      const session = createSession({ expiresAt: new Date(clock.now() + 60_000).toISOString() });
      const conn = createMockConnection(session.id);
      registry.register(conn);

      const cleanup = bridge.bindSession(session, conn as never);

      // Broadcast an expiring-soon event with a new expiresAt in the past
      broadcaster.broadcast(session.id, {
        type: 'state-change',
        previousState: 'active',
        newState: 'expiring-soon',
        expiresAt: new Date(clock.now() - 100).toISOString(),
      });

      // Should get expiring-soon notification then immediate termination
      const expiringSoon = conn.sent.find((m) => m.type === 'session-expiring-soon');
      const terminated = conn.sent.find((m) => m.type === 'session-terminated');
      assert.ok(expiringSoon, 'Expected session-expiring-soon message');
      assert.ok(terminated, 'Expected session-terminated for past expiresAt');
      cleanup();
    });

    it('ignores invalid expiresAt in daemon-unreachable event', () => {
      const session = createSession({ expiresAt: new Date(clock.now() + 60_000).toISOString() });
      const conn = createMockConnection(session.id);
      registry.register(conn);

      const cleanup = bridge.bindSession(session, conn as never);

      broadcaster.broadcast(session.id, {
        type: 'state-change',
        previousState: 'active',
        newState: 'daemon-unreachable',
        expiresAt: 'garbage-date',
      });

      // Should get daemon-unavailable but no termination (invalid date is ignored)
      const daemonMsg = conn.sent.find((m) => m.type === 'daemon-unavailable');
      const terminated = conn.sent.find((m) => m.type === 'session-terminated');
      assert.ok(daemonMsg, 'Expected daemon-unavailable message');
      assert.equal(terminated, undefined, 'Should not terminate for invalid expiresAt');
      cleanup();
    });
  });
});
