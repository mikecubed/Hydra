import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionRegistry, type ManagedConnection } from '../connection-registry.ts';
import type { ServerMessage } from '../ws-protocol.ts';

function fakeConnection(
  connectionId: string,
  sessionId: string,
  overrides?: Partial<ManagedConnection>,
): ManagedConnection {
  let closed = false;
  const connection: ManagedConnection = {
    connectionId,
    sessionId,
    subscribedConversations: new Set(),
    lastAckSeq: new Map(),
    replayState: new Map(),
    pendingEvents: new Map(),
    bufferedAmount: 0,
    send: (_message: ServerMessage) => {},
    updateAck: (conversationId: string, seq: number) => {
      const current = connection.lastAckSeq.get(conversationId) ?? -1;
      if (seq > current) {
        connection.lastAckSeq.set(conversationId, seq);
      }
    },
    close: () => {
      closed = true;
    },
    get isClosed() {
      return closed;
    },
    ...overrides,
  };
  return connection;
}

describe('ConnectionRegistry', () => {
  let registry: ConnectionRegistry;

  beforeEach(() => {
    registry = new ConnectionRegistry();
  });

  // ─── register / unregister ───────────────────────────────────────────────

  describe('register', () => {
    it('registers a connection and indexes by session', () => {
      const conn = fakeConnection('c1', 's1');
      registry.register(conn);
      const bySession = registry.getBySession('s1');
      assert.equal(bySession.size, 1);
      assert.ok(bySession.has(conn));
    });

    it('supports multiple connections per session (multi-tab)', () => {
      const c1 = fakeConnection('c1', 's1');
      const c2 = fakeConnection('c2', 's1');
      registry.register(c1);
      registry.register(c2);
      assert.equal(registry.getBySession('s1').size, 2);
    });

    it('ignores duplicate registration of same connectionId', () => {
      const conn = fakeConnection('c1', 's1');
      registry.register(conn);
      registry.register(conn);
      assert.equal(registry.getBySession('s1').size, 1);
    });
  });

  describe('unregister', () => {
    it('removes connection from session index', () => {
      const conn = fakeConnection('c1', 's1');
      registry.register(conn);
      registry.unregister('c1');
      assert.equal(registry.getBySession('s1').size, 0);
      const internal = registry as unknown as { bySession: Map<string, Set<ManagedConnection>> };
      assert.equal(internal.bySession.has('s1'), false);
    });

    it('removes connection from all conversation indices', () => {
      const conn = fakeConnection('c1', 's1');
      registry.register(conn);
      registry.addSubscription('c1', 'conv-a');
      registry.addSubscription('c1', 'conv-b');
      registry.unregister('c1');
      assert.equal(registry.getByConversation('conv-a').size, 0);
      assert.equal(registry.getByConversation('conv-b').size, 0);
      const internal = registry as unknown as {
        byConversation: Map<string, Set<ManagedConnection>>;
      };
      assert.equal(internal.byConversation.has('conv-a'), false);
      assert.equal(internal.byConversation.has('conv-b'), false);
    });

    it('is a no-op for unknown connectionId', () => {
      assert.doesNotThrow(() => {
        registry.unregister('nonexistent');
      });
    });

    it('does not affect other connections in same session', () => {
      const c1 = fakeConnection('c1', 's1');
      const c2 = fakeConnection('c2', 's1');
      registry.register(c1);
      registry.register(c2);
      registry.unregister('c1');
      assert.equal(registry.getBySession('s1').size, 1);
      assert.ok(registry.getBySession('s1').has(c2));
    });
  });

  // ─── getBySession / getByConversation ────────────────────────────────────

  describe('getBySession', () => {
    it('returns empty set for unknown session', () => {
      assert.equal(registry.getBySession('unknown').size, 0);
    });
  });

  describe('getByConversation', () => {
    it('returns empty set for unknown conversation', () => {
      assert.equal(registry.getByConversation('unknown').size, 0);
    });

    it('returns connections subscribed to a conversation', () => {
      const c1 = fakeConnection('c1', 's1');
      const c2 = fakeConnection('c2', 's2');
      registry.register(c1);
      registry.register(c2);
      registry.addSubscription('c1', 'conv-1');
      registry.addSubscription('c2', 'conv-1');
      const result = registry.getByConversation('conv-1');
      assert.equal(result.size, 2);
    });
  });

  // ─── addSubscription / removeSubscription ────────────────────────────────

  describe('addSubscription', () => {
    it('adds connection to conversation index', () => {
      const conn = fakeConnection('c1', 's1');
      registry.register(conn);
      registry.addSubscription('c1', 'conv-1');
      assert.equal(registry.getByConversation('conv-1').size, 1);
      assert.ok(conn.subscribedConversations.has('conv-1'));
    });

    it('is idempotent for same subscription', () => {
      const conn = fakeConnection('c1', 's1');
      registry.register(conn);
      registry.addSubscription('c1', 'conv-1');
      registry.addSubscription('c1', 'conv-1');
      assert.equal(registry.getByConversation('conv-1').size, 1);
    });

    it('is a no-op for unknown connectionId', () => {
      assert.doesNotThrow(() => {
        registry.addSubscription('nonexistent', 'conv-1');
      });
    });
  });

  describe('removeSubscription', () => {
    it('removes connection from conversation index', () => {
      const conn = fakeConnection('c1', 's1');
      registry.register(conn);
      registry.addSubscription('c1', 'conv-1');
      registry.removeSubscription('c1', 'conv-1');
      assert.equal(registry.getByConversation('conv-1').size, 0);
      assert.ok(!conn.subscribedConversations.has('conv-1'));
      const internal = registry as unknown as {
        byConversation: Map<string, Set<ManagedConnection>>;
      };
      assert.equal(internal.byConversation.has('conv-1'), false);
    });

    it('does not affect other conversations', () => {
      const conn = fakeConnection('c1', 's1');
      registry.register(conn);
      registry.addSubscription('c1', 'conv-a');
      registry.addSubscription('c1', 'conv-b');
      registry.removeSubscription('c1', 'conv-a');
      assert.equal(registry.getByConversation('conv-b').size, 1);
    });

    it('is a no-op for unknown connectionId', () => {
      assert.doesNotThrow(() => {
        registry.removeSubscription('nonexistent', 'conv-1');
      });
    });
  });

  // ─── closeAllForSession ──────────────────────────────────────────────────

  describe('closeAllForSession', () => {
    it('closes all connections for a session', () => {
      const c1 = fakeConnection('c1', 's1');
      const c2 = fakeConnection('c2', 's1');
      registry.register(c1);
      registry.register(c2);
      registry.closeAllForSession('s1');
      assert.ok(c1.isClosed);
      assert.ok(c2.isClosed);
    });

    it('removes all connections from session index', () => {
      const c1 = fakeConnection('c1', 's1');
      registry.register(c1);
      registry.addSubscription('c1', 'conv-1');
      registry.closeAllForSession('s1');
      assert.equal(registry.getBySession('s1').size, 0);
    });

    it('cleans conversation indices for all closed connections', () => {
      const c1 = fakeConnection('c1', 's1');
      const c2 = fakeConnection('c2', 's1');
      registry.register(c1);
      registry.register(c2);
      registry.addSubscription('c1', 'conv-a');
      registry.addSubscription('c2', 'conv-a');
      registry.addSubscription('c2', 'conv-b');
      registry.closeAllForSession('s1');
      assert.equal(registry.getByConversation('conv-a').size, 0);
      assert.equal(registry.getByConversation('conv-b').size, 0);
    });

    it('does not affect other sessions', () => {
      const c1 = fakeConnection('c1', 's1');
      const c2 = fakeConnection('c2', 's2');
      registry.register(c1);
      registry.register(c2);
      registry.addSubscription('c2', 'conv-1');
      registry.closeAllForSession('s1');
      assert.ok(!c2.isClosed);
      assert.equal(registry.getBySession('s2').size, 1);
      assert.equal(registry.getByConversation('conv-1').size, 1);
    });

    it('is a no-op for unknown session', () => {
      assert.doesNotThrow(() => {
        registry.closeAllForSession('nonexistent');
      });
    });
  });

  // ─── size ────────────────────────────────────────────────────────────────

  describe('size', () => {
    it('returns 0 when empty', () => {
      assert.equal(registry.size, 0);
    });

    it('tracks total connections', () => {
      registry.register(fakeConnection('c1', 's1'));
      registry.register(fakeConnection('c2', 's2'));
      assert.equal(registry.size, 2);
    });

    it('decrements on unregister', () => {
      registry.register(fakeConnection('c1', 's1'));
      registry.unregister('c1');
      assert.equal(registry.size, 0);
    });
  });
});
