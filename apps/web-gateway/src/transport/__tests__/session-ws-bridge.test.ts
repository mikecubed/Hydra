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
    pendingConversations: new Set(),
    subscribeGenerations: new Map(),
    lastAckSeq: new Map(),
    replayState: new Map(),
    pendingEvents: new Map(),
    lastDeliveredSeq: new Map(),
    bufferedAmount: 0,
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
    it('fails closed for invalid date strings', () => {
      const session = createSession({ expiresAt: 'not-a-date' });
      const conn = createMockConnection(session.id);
      registry.register(conn);

      const cleanup = bridge.bindSession(session, conn as never);

      const terminated = conn.sent.find((m) => m.type === 'session-terminated');
      assert.ok(terminated, 'Invalid expiresAt should terminate the session');
      cleanup();
    });

    it('fails closed for empty expiresAt string', () => {
      const session = createSession({ expiresAt: '' });
      const conn = createMockConnection(session.id);
      registry.register(conn);

      const cleanup = bridge.bindSession(session, conn as never);
      const terminated = conn.sent.find((m) => m.type === 'session-terminated');
      assert.ok(terminated, 'Empty expiresAt should terminate the session');
      cleanup();
    });
  });

  describe('warning timer', () => {
    it('sends session-expiring-soon from timer without explicit validate()', async () => {
      const warningThresholdMs = 200;
      const localBridge = new SessionWsBridge({ broadcaster, registry, clock, warningThresholdMs });

      // Session expires 500ms from clock.now(); warning fires at 300ms
      const expiresAt = new Date(clock.now() + 500).toISOString();
      const session = createSession({ expiresAt });
      const conn = createMockConnection(session.id);
      registry.register(conn);

      const cleanup = localBridge.bindSession(session, conn as never);
      try {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 400);
        });

        assert.ok(
          conn.sent.some((m) => m.type === 'session-expiring-soon'),
          'Expected session-expiring-soon from warning timer',
        );
        assert.ok(
          !conn.sent.some((m) => m.type === 'session-terminated'),
          'Expected no termination yet',
        );
      } finally {
        cleanup();
      }
    });

    it('does not schedule a warning timer when already in the warning window', () => {
      const warningThresholdMs = 200;
      const localBridge = new SessionWsBridge({ broadcaster, registry, clock, warningThresholdMs });

      // Session expires 100ms from now — already within 200ms warning threshold
      const expiresAt = new Date(clock.now() + 100).toISOString();
      const session = createSession({ state: 'expiring-soon', expiresAt });
      const conn = createMockConnection(session.id);
      registry.register(conn);

      const cleanup = localBridge.bindSession(session, conn as never);
      try {
        // The expiring-soon replay message should be sent immediately
        const warnings = conn.sent.filter((m) => m.type === 'session-expiring-soon');
        assert.equal(warnings.length, 1);
      } finally {
        cleanup();
      }
    });

    it('emits session-expiring-soon immediately when active session binds inside warning window', () => {
      const warningThresholdMs = 200;
      const localBridge = new SessionWsBridge({ broadcaster, registry, clock, warningThresholdMs });

      // Session expires 100ms from now — already within 200ms warning threshold
      // State is 'active' (e.g. daemon recovery restored an active session near expiry)
      const expiresAt = new Date(clock.now() + 100).toISOString();
      const session = createSession({ state: 'active', expiresAt });
      const conn = createMockConnection(session.id);
      registry.register(conn);

      const cleanup = localBridge.bindSession(session, conn as never);
      try {
        const warnings = conn.sent.filter((m) => m.type === 'session-expiring-soon');
        assert.equal(warnings.length, 1);
        // Should still schedule expiry — not terminate immediately
        assert.ok(
          !conn.sent.some((m) => m.type === 'session-terminated'),
          'Should not terminate immediately; expiry timer should still be pending',
        );
      } finally {
        cleanup();
      }
    });

    it('emits session-expiring-soon immediately on daemon recovery inside warning window', () => {
      const warningThresholdMs = 300;
      const localBridge = new SessionWsBridge({ broadcaster, registry, clock, warningThresholdMs });

      // Start with a long-lived active session
      const farExpiry = new Date(clock.now() + 60_000).toISOString();
      const session = createSession({ state: 'active', expiresAt: farExpiry });
      const conn = createMockConnection(session.id);
      registry.register(conn);

      const cleanup = localBridge.bindSession(session, conn as never);
      try {
        // Simulate daemon recovery that transitions back to active with near-expiry
        const nearExpiry = new Date(clock.now() + 150).toISOString();
        broadcaster.broadcast(session.id, {
          type: 'state-change',
          previousState: 'daemon-unreachable',
          newState: 'active',
          expiresAt: nearExpiry,
        });

        // applyExpiry is called for 'active' state — should emit warning immediately
        const warnings = conn.sent.filter((m) => m.type === 'session-expiring-soon');
        assert.equal(warnings.length, 1);
        // daemon-restored should also be sent since previous state was daemon-unreachable
        assert.ok(
          conn.sent.some((m) => m.type === 'daemon-restored'),
          'Expected daemon-restored message',
        );
      } finally {
        cleanup();
      }
    });

    it('emits session-active when an expiring session is extended back to active', () => {
      const nearExpiry = new Date(clock.now() + 5_000).toISOString();
      const session = createSession({ state: 'expiring-soon', expiresAt: nearExpiry });
      const conn = createMockConnection(session.id);
      registry.register(conn);

      const cleanup = bridge.bindSession(session, conn as never);
      try {
        const extendedExpiry = new Date(clock.now() + 60_000).toISOString();
        broadcaster.broadcast(session.id, {
          type: 'state-change',
          previousState: 'expiring-soon',
          newState: 'active',
          expiresAt: extendedExpiry,
          trigger: 'extend',
        });

        assert.ok(
          conn.sent.some(
            (message) => message.type === 'session-active' && message.expiresAt === extendedExpiry,
          ),
          'Expected session-active message after extension returns to active',
        );
      } finally {
        cleanup();
      }
    });

    it('deduplicates warning messages across recovery and later expiring-soon transition', () => {
      const warningThresholdMs = 300;
      const localBridge = new SessionWsBridge({ broadcaster, registry, clock, warningThresholdMs });

      const farExpiry = new Date(clock.now() + 60_000).toISOString();
      const session = createSession({ state: 'active', expiresAt: farExpiry });
      const conn = createMockConnection(session.id);
      registry.register(conn);

      const cleanup = localBridge.bindSession(session, conn as never);
      try {
        const nearExpiry = new Date(clock.now() + 150).toISOString();
        broadcaster.broadcast(session.id, {
          type: 'state-change',
          previousState: 'daemon-unreachable',
          newState: 'active',
          expiresAt: nearExpiry,
        });
        broadcaster.broadcast(session.id, {
          type: 'state-change',
          previousState: 'active',
          newState: 'expiring-soon',
          expiresAt: nearExpiry,
        });

        const warnings = conn.sent.filter((m) => m.type === 'session-expiring-soon');
        assert.equal(warnings.length, 1);
      } finally {
        cleanup();
      }
    });

    it('clears the warning timer on cleanup', async () => {
      const warningThresholdMs = 200;
      const localBridge = new SessionWsBridge({ broadcaster, registry, clock, warningThresholdMs });

      const expiresAt = new Date(clock.now() + 500).toISOString();
      const session = createSession({ expiresAt });
      const conn = createMockConnection(session.id);
      registry.register(conn);

      const cleanup = localBridge.bindSession(session, conn as never);
      cleanup();

      // Wait past when warning would have fired
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 400);
      });

      assert.ok(
        !conn.sent.some((m) => m.type === 'session-expiring-soon'),
        'Warning timer should have been cleared by cleanup',
      );
    });
  });

  describe('broadcaster events', () => {
    it('sends expiring-soon before terminating for past expiresAt', () => {
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
      assert.equal(conn.sent[0]?.type, 'session-expiring-soon');
      assert.equal(conn.sent[1]?.type, 'session-terminated');
      cleanup();
    });

    it('sends daemon-unavailable before terminating for invalid expiresAt', () => {
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

      assert.equal(conn.sent[0]?.type, 'daemon-unavailable');
      assert.equal(conn.sent[1]?.type, 'session-terminated');
      cleanup();
    });
  });
});
