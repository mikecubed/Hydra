import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { WsConnection } from '../ws-connection.ts';
import { ConnectionRegistry } from '../connection-registry.ts';

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
