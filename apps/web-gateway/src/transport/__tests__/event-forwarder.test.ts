import { describe, it, beforeEach } from 'node:test';
import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import type { StreamEvent } from '@hydra/web-contracts';
import { serializeServerMessage } from '../ws-protocol.ts';
import { EventBuffer } from '../event-buffer.ts';
import { ConnectionRegistry, type ManagedConnection } from '../connection-registry.ts';
import type { ServerMessage } from '../ws-protocol.ts';
import { EventForwarder, type StreamEventPayload } from '../event-forwarder.ts';

// ─── helpers ────────────────────────────────────────────────────────────────

function makeEvent(
  seq: number,
  turnId = 'turn-1',
  kind: StreamEvent['kind'] = 'text-delta',
): StreamEvent {
  return {
    seq,
    turnId,
    kind,
    payload: { text: `chunk-${seq}` },
    timestamp: new Date().toISOString(),
  };
}

interface SpyConnection extends ManagedConnection {
  sent: ServerMessage[];
  _bufferedAmount: number;
  closeCode?: number;
  closeReason?: string;
}

function fakeConnection(connectionId: string, sessionId: string): SpyConnection {
  let closed = false;
  const conn: SpyConnection = {
    connectionId,
    sessionId,
    subscribedConversations: new Set<string>(),
    pendingConversations: new Set<string>(),
    lastAckSeq: new Map<string, number>(),
    replayState: new Map(),
    pendingEvents: new Map(),
    sent: [],
    _bufferedAmount: 0,
    get bufferedAmount() {
      return conn._bufferedAmount;
    },
    send(message: ServerMessage) {
      conn.sent.push(message);
    },
    updateAck(conversationId: string, seq: number) {
      const current = conn.lastAckSeq.get(conversationId) ?? -1;
      if (seq > current) conn.lastAckSeq.set(conversationId, seq);
    },
    close(code?: number, reason?: string) {
      closed = true;
      conn.closeCode = code;
      conn.closeReason = reason;
    },
    get isClosed() {
      return closed;
    },
  };
  return conn;
}

function streamEventSize(conversationId: string, event: StreamEvent): number {
  return Buffer.byteLength(
    serializeServerMessage({
      type: 'stream-event',
      conversationId,
      event,
    }),
    'utf8',
  );
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

// ─── tests ──────────────────────────────────────────────────────────────────

describe('EventForwarder', () => {
  let bridge: FakeEventBridge;
  let buffer: EventBuffer;
  let registry: ConnectionRegistry;
  let forwarder: EventForwarder;

  beforeEach(() => {
    bridge = new FakeEventBridge();
    buffer = new EventBuffer();
    registry = new ConnectionRegistry();
    forwarder = new EventForwarder(bridge, buffer, registry);
    // start() subscribes to the bridge
    forwarder.start();
  });

  // ─── single subscriber delivery ─────────────────────────────────────────

  describe('single subscriber delivery', () => {
    it('delivers a stream-event to a subscribed connection', () => {
      const conn = fakeConnection('c1', 's1');
      registry.register(conn);
      registry.addSubscription('c1', 'conv-1');

      const event = makeEvent(1);
      bridge.emitStreamEvent('conv-1', event);

      assert.equal(conn.sent.length, 1);
      const msg = conn.sent[0];
      assert.equal(msg.type, 'stream-event');
      assert.equal((msg as { conversationId: string }).conversationId, 'conv-1');
      assert.deepStrictEqual((msg as { event: StreamEvent }).event, event);
    });
  });

  // ─── multi-subscriber delivery ──────────────────────────────────────────

  describe('multi-subscriber delivery', () => {
    it('delivers the same event to all subscribed connections', () => {
      const conn1 = fakeConnection('c1', 's1');
      const conn2 = fakeConnection('c2', 's2');
      registry.register(conn1);
      registry.register(conn2);
      registry.addSubscription('c1', 'conv-1');
      registry.addSubscription('c2', 'conv-1');

      const event = makeEvent(5);
      bridge.emitStreamEvent('conv-1', event);

      assert.equal(conn1.sent.length, 1);
      assert.equal(conn2.sent.length, 1);
      assert.equal(conn1.sent[0].type, 'stream-event');
      assert.equal(conn2.sent[0].type, 'stream-event');
    });

    it('continues delivering to later subscribers when one connection send throws', () => {
      const failing = fakeConnection('c1', 's1');
      failing.send = () => {
        throw new Error('boom');
      };
      const healthy = fakeConnection('c2', 's2');
      registry.register(failing);
      registry.register(healthy);
      registry.addSubscription('c1', 'conv-1');
      registry.addSubscription('c2', 'conv-1');

      bridge.emitStreamEvent('conv-1', makeEvent(9));

      assert.equal(failing.isClosed, true);
      assert.equal(healthy.sent.length, 1);
      assert.equal(healthy.sent[0].type, 'stream-event');
    });
  });

  // ─── unsubscribed exclusion ─────────────────────────────────────────────

  describe('unsubscribed exclusion', () => {
    it('does not deliver events to unsubscribed connections', () => {
      const subscribed = fakeConnection('c1', 's1');
      const unsubscribed = fakeConnection('c2', 's2');
      registry.register(subscribed);
      registry.register(unsubscribed);
      registry.addSubscription('c1', 'conv-1');
      // c2 NOT subscribed to conv-1

      bridge.emitStreamEvent('conv-1', makeEvent(1));

      assert.equal(subscribed.sent.length, 1);
      assert.equal(unsubscribed.sent.length, 0);
    });

    it('does not deliver events when no connections are subscribed', () => {
      // Just emit — no subscribers at all
      bridge.emitStreamEvent('conv-1', makeEvent(1));
      assert.deepEqual(buffer.getEventsSince('conv-1', 0), []);
    });
  });

  // ─── buffer population on every forward ─────────────────────────────────

  describe('buffer population', () => {
    it('pushes every forwarded event into the EventBuffer', () => {
      const conn = fakeConnection('c1', 's1');
      registry.register(conn);
      registry.addSubscription('c1', 'conv-1');

      bridge.emitStreamEvent('conv-1', makeEvent(1));
      bridge.emitStreamEvent('conv-1', makeEvent(2));
      bridge.emitStreamEvent('conv-1', makeEvent(3));

      const buffered = buffer.getEventsSince('conv-1', 0);
      assert.equal(buffered.length, 3);
      assert.deepStrictEqual(
        buffered.map((e) => e.seq),
        [1, 2, 3],
      );
    });

    it('populates buffer while a subscribe is still validating', () => {
      const conn = fakeConnection('c1', 's1');
      registry.register(conn);
      registry.addPendingInterest('c1', 'conv-1');

      bridge.emitStreamEvent('conv-1', makeEvent(10));

      const buffered = buffer.getEventsSince('conv-1', 0);
      assert.equal(buffered.length, 1);
      assert.equal(buffered[0].seq, 10);
    });

    it('stops buffering once the last interest is removed', () => {
      const conn = fakeConnection('c1', 's1');
      registry.register(conn);
      registry.addSubscription('c1', 'conv-1');

      bridge.emitStreamEvent('conv-1', makeEvent(1));
      registry.removeSubscription('c1', 'conv-1');
      bridge.emitStreamEvent('conv-1', makeEvent(2));

      assert.deepEqual(
        buffer.getEventsSince('conv-1', 0).map((event) => event.seq),
        [1],
      );
    });
  });

  // ─── replay-state queueing ─────────────────────────────────────────────

  describe('replay-state queueing for one conversation', () => {
    it('queues events when connection replay state is replaying', () => {
      const conn = fakeConnection('c1', 's1');
      registry.register(conn);
      registry.addSubscription('c1', 'conv-1');

      // Simulate T026 setting replay state
      conn.replayState.set('conv-1', 'replaying');
      conn.pendingEvents.set('conv-1', []);

      bridge.emitStreamEvent('conv-1', makeEvent(10));
      bridge.emitStreamEvent('conv-1', makeEvent(11));

      // Nothing sent immediately
      assert.equal(conn.sent.length, 0);
      // Events are queued in pendingEvents
      const pending = conn.pendingEvents.get('conv-1')!;
      assert.equal(pending.length, 2);
      assert.equal(pending[0].seq, 10);
      assert.equal(pending[1].seq, 11);
    });

    it('sends events when replay state is live', () => {
      const conn = fakeConnection('c1', 's1');
      registry.register(conn);
      registry.addSubscription('c1', 'conv-1');

      conn.replayState.set('conv-1', 'live');

      bridge.emitStreamEvent('conv-1', makeEvent(5));

      assert.equal(conn.sent.length, 1);
      assert.equal(conn.sent[0].type, 'stream-event');
    });

    it('sends events when replay state has no entry (default live)', () => {
      const conn = fakeConnection('c1', 's1');
      registry.register(conn);
      registry.addSubscription('c1', 'conv-1');
      // No replayState entry

      bridge.emitStreamEvent('conv-1', makeEvent(5));

      assert.equal(conn.sent.length, 1);
    });

    it('queues and sends to different connections independently', () => {
      const replaying = fakeConnection('c1', 's1');
      const live = fakeConnection('c2', 's2');
      registry.register(replaying);
      registry.register(live);
      registry.addSubscription('c1', 'conv-1');
      registry.addSubscription('c2', 'conv-1');

      replaying.replayState.set('conv-1', 'replaying');
      replaying.pendingEvents.set('conv-1', []);

      bridge.emitStreamEvent('conv-1', makeEvent(7));

      // replaying conn queues
      assert.equal(replaying.sent.length, 0);
      assert.equal(replaying.pendingEvents.get('conv-1')!.length, 1);
      // live conn receives immediately
      assert.equal(live.sent.length, 1);
    });
  });

  // ─── concurrent replay on conversation A while B remains live ──────────

  describe('concurrent replay A while conversation B is live', () => {
    it('queues events for replaying conversation A but sends for live conversation B on the same connection', () => {
      const conn = fakeConnection('c1', 's1');
      registry.register(conn);
      registry.addSubscription('c1', 'conv-A');
      registry.addSubscription('c1', 'conv-B');

      // conv-A is replaying, conv-B is live (no entry = live)
      conn.replayState.set('conv-A', 'replaying');
      conn.pendingEvents.set('conv-A', []);

      // Emit events for both conversations
      bridge.emitStreamEvent('conv-A', makeEvent(1, 'turn-a1'));
      bridge.emitStreamEvent('conv-B', makeEvent(2, 'turn-b1'));
      bridge.emitStreamEvent('conv-A', makeEvent(3, 'turn-a2'));
      bridge.emitStreamEvent('conv-B', makeEvent(4, 'turn-b2'));

      // conv-A events queued, not sent
      const pendingA = conn.pendingEvents.get('conv-A')!;
      assert.equal(pendingA.length, 2);
      assert.equal(pendingA[0].seq, 1);
      assert.equal(pendingA[1].seq, 3);

      // conv-B events sent immediately
      const sentB = conn.sent.filter(
        (m) =>
          m.type === 'stream-event' &&
          (m as { conversationId: string }).conversationId === 'conv-B',
      );
      assert.equal(sentB.length, 2);

      // No conv-A events in sent
      const sentA = conn.sent.filter(
        (m) =>
          m.type === 'stream-event' &&
          (m as { conversationId: string }).conversationId === 'conv-A',
      );
      assert.equal(sentA.length, 0);
    });
  });

  // ─── T028: multi-tab event forwarding (same session, different tabs) ───

  describe('T028: multi-tab event forwarding', () => {
    it('delivers the same event to two tabs (connections) in the same session', () => {
      const tab1 = fakeConnection('tab-1', 'session-A');
      const tab2 = fakeConnection('tab-2', 'session-A');
      registry.register(tab1);
      registry.register(tab2);
      registry.addSubscription('tab-1', 'conv-1');
      registry.addSubscription('tab-2', 'conv-1');

      const event = makeEvent(1);
      bridge.emitStreamEvent('conv-1', event);

      assert.equal(tab1.sent.length, 1);
      assert.equal(tab2.sent.length, 1);
      assert.deepStrictEqual((tab1.sent[0] as { event: StreamEvent }).event, event);
      assert.deepStrictEqual((tab2.sent[0] as { event: StreamEvent }).event, event);
    });

    it('delivers a sequence of events to all tabs in the same session', () => {
      const tab1 = fakeConnection('tab-1', 'session-A');
      const tab2 = fakeConnection('tab-2', 'session-A');
      const tab3 = fakeConnection('tab-3', 'session-A');
      registry.register(tab1);
      registry.register(tab2);
      registry.register(tab3);
      registry.addSubscription('tab-1', 'conv-1');
      registry.addSubscription('tab-2', 'conv-1');
      registry.addSubscription('tab-3', 'conv-1');

      bridge.emitStreamEvent('conv-1', makeEvent(1));
      bridge.emitStreamEvent('conv-1', makeEvent(2));
      bridge.emitStreamEvent('conv-1', makeEvent(3));

      for (const tab of [tab1, tab2, tab3]) {
        assert.equal(tab.sent.length, 3, `${tab.connectionId} should have 3 events`);
        assert.deepStrictEqual(
          tab.sent.map((m) => (m as { event: StreamEvent }).event.seq),
          [1, 2, 3],
        );
      }
    });

    it('stops delivering to an unsubscribed tab while other tabs continue', () => {
      const tab1 = fakeConnection('tab-1', 'session-A');
      const tab2 = fakeConnection('tab-2', 'session-A');
      registry.register(tab1);
      registry.register(tab2);
      registry.addSubscription('tab-1', 'conv-1');
      registry.addSubscription('tab-2', 'conv-1');

      bridge.emitStreamEvent('conv-1', makeEvent(1));
      assert.equal(tab1.sent.length, 1);
      assert.equal(tab2.sent.length, 1);

      // tab-2 unsubscribes
      registry.removeSubscription('tab-2', 'conv-1');

      bridge.emitStreamEvent('conv-1', makeEvent(2));
      assert.equal(tab1.sent.length, 2);
      assert.equal(tab2.sent.length, 1); // no new event
    });

    it('handles replay state independently per tab in the same session', () => {
      const tab1 = fakeConnection('tab-1', 'session-A');
      const tab2 = fakeConnection('tab-2', 'session-A');
      registry.register(tab1);
      registry.register(tab2);
      registry.addSubscription('tab-1', 'conv-1');
      registry.addSubscription('tab-2', 'conv-1');

      // tab-1 is replaying, tab-2 is live
      tab1.replayState.set('conv-1', 'replaying');
      tab1.pendingEvents.set('conv-1', []);

      bridge.emitStreamEvent('conv-1', makeEvent(10));

      // tab-1: queued, not sent
      assert.equal(tab1.sent.length, 0);
      assert.equal(tab1.pendingEvents.get('conv-1')!.length, 1);
      // tab-2: received immediately
      assert.equal(tab2.sent.length, 1);
      assert.equal((tab2.sent[0] as { event: StreamEvent }).event.seq, 10);
    });

    it('isolates conversation subscriptions across tabs in the same session', () => {
      const tab1 = fakeConnection('tab-1', 'session-A');
      const tab2 = fakeConnection('tab-2', 'session-A');
      registry.register(tab1);
      registry.register(tab2);
      // tab-1 subscribes to conv-1, tab-2 subscribes to conv-2
      registry.addSubscription('tab-1', 'conv-1');
      registry.addSubscription('tab-2', 'conv-2');

      bridge.emitStreamEvent('conv-1', makeEvent(1, 'turn-a'));
      bridge.emitStreamEvent('conv-2', makeEvent(2, 'turn-b'));

      assert.equal(tab1.sent.length, 1);
      assert.equal((tab1.sent[0] as { conversationId: string }).conversationId, 'conv-1');

      assert.equal(tab2.sent.length, 1);
      assert.equal((tab2.sent[0] as { conversationId: string }).conversationId, 'conv-2');
    });
  });

  // ─── T029: buffer overflow / backpressure handling ──────────────────────

  describe('T029: buffer overflow / backpressure', () => {
    const HIGH_WATER_MARK = 1024;

    let bpBridge: FakeEventBridge;
    let bpBuffer: EventBuffer;
    let bpRegistry: ConnectionRegistry;
    let bpForwarder: EventForwarder;

    beforeEach(() => {
      bpBridge = new FakeEventBridge();
      bpBuffer = new EventBuffer();
      bpRegistry = new ConnectionRegistry();
      bpForwarder = new EventForwarder(bpBridge, bpBuffer, bpRegistry, {
        bufferHighWaterMark: HIGH_WATER_MARK,
      });
      bpForwarder.start();
    });

    it('closes a connection whose bufferedAmount exceeds the threshold', () => {
      const conn = fakeConnection('c1', 's1');
      const event = makeEvent(1);
      conn._bufferedAmount = HIGH_WATER_MARK + 1;
      bpRegistry.register(conn);
      bpRegistry.addSubscription('c1', 'conv-1');

      bpBridge.emitStreamEvent('conv-1', event);

      assert.equal(conn.isClosed, true);
      assert.equal(conn.closeCode, 1008);
      assert.equal(conn.closeReason, 'WS_BUFFER_OVERFLOW');
    });

    it('sends a WS_BUFFER_OVERFLOW error frame before closing', () => {
      const conn = fakeConnection('c1', 's1');
      const event = makeEvent(1);
      conn._bufferedAmount = HIGH_WATER_MARK + 1;
      bpRegistry.register(conn);
      bpRegistry.addSubscription('c1', 'conv-1');

      bpBridge.emitStreamEvent('conv-1', event);

      // Should receive an error message, not the stream-event
      const errorMsg = conn.sent.find((m) => m.type === 'error');
      assert.ok(errorMsg, 'Expected a WS_BUFFER_OVERFLOW error message');
      assert.equal((errorMsg as { code: string }).code, 'WS_BUFFER_OVERFLOW');
      assert.equal((errorMsg as { category: string }).category, 'daemon');

      const streamEvents = conn.sent.filter((m) => m.type === 'stream-event');
      assert.equal(streamEvents.length, 0, 'Should not deliver stream-event on overflow');
    });

    it('delivers normally when bufferedAmount is below the threshold', () => {
      const conn = fakeConnection('c1', 's1');
      const event = makeEvent(1);
      conn._bufferedAmount = HIGH_WATER_MARK - streamEventSize('conv-1', event);
      bpRegistry.register(conn);
      bpRegistry.addSubscription('c1', 'conv-1');

      bpBridge.emitStreamEvent('conv-1', event);

      assert.equal(conn.isClosed, false);
      assert.equal(conn.sent.length, 1);
      assert.equal(conn.sent[0].type, 'stream-event');
    });

    it('closes immediately when the next event would push bufferedAmount past the threshold', () => {
      const conn = fakeConnection('c1', 's1');
      const event = makeEvent(1);
      conn._bufferedAmount = HIGH_WATER_MARK - streamEventSize('conv-1', event) + 1;
      bpRegistry.register(conn);
      bpRegistry.addSubscription('c1', 'conv-1');

      bpBridge.emitStreamEvent('conv-1', event);

      assert.equal(conn.isClosed, true);
      assert.equal(conn.closeCode, 1008);
      assert.equal(conn.sent[0].type, 'error');
    });

    it('closes only the slow connection while healthy connections continue', () => {
      const slow = fakeConnection('slow', 's1');
      slow._bufferedAmount = HIGH_WATER_MARK * 2;
      const fast = fakeConnection('fast', 's2');
      fast._bufferedAmount = 0;
      bpRegistry.register(slow);
      bpRegistry.register(fast);
      bpRegistry.addSubscription('slow', 'conv-1');
      bpRegistry.addSubscription('fast', 'conv-1');

      bpBridge.emitStreamEvent('conv-1', makeEvent(1));

      assert.equal(slow.isClosed, true);
      assert.equal(fast.isClosed, false);
      assert.equal(fast.sent.filter((m) => m.type === 'stream-event').length, 1);
    });

    it('still buffers the event even when all connections overflow', () => {
      const conn = fakeConnection('c1', 's1');
      conn._bufferedAmount = HIGH_WATER_MARK + 1;
      bpRegistry.register(conn);
      bpRegistry.addSubscription('c1', 'conv-1');

      bpBridge.emitStreamEvent('conv-1', makeEvent(42));

      // Event must still be in the buffer (buffering happens before forwarding)
      const buffered = bpBuffer.getEventsSince('conv-1', 0);
      assert.equal(buffered.length, 1);
      assert.equal(buffered[0].seq, 42);
    });

    it('queues live events during replay without closing the connection immediately', () => {
      const conn = fakeConnection('c1', 's1');
      conn._bufferedAmount = HIGH_WATER_MARK + 1;
      conn.replayState.set('conv-1', 'replaying');
      conn.pendingEvents.set('conv-1', []);
      bpRegistry.register(conn);
      bpRegistry.addSubscription('c1', 'conv-1');

      bpBridge.emitStreamEvent('conv-1', makeEvent(5));

      // Replay barrier still queues live arrivals; overflow is enforced when replay flushes.
      assert.equal(conn.isClosed, false);
      assert.equal(conn.pendingEvents.get('conv-1')!.length, 1);
    });

    it('uses default high-water mark when no option is provided', () => {
      // Re-use the outer forwarder (no bufferHighWaterMark option)
      const conn = fakeConnection('c-default', 's1');
      // Default should be 1MB — well above zero
      conn._bufferedAmount = 0;
      registry.register(conn);
      registry.addSubscription('c-default', 'conv-1');

      bridge.emitStreamEvent('conv-1', makeEvent(1));

      assert.equal(conn.isClosed, false);
      assert.equal(conn.sent.length, 1);
    });
  });

  // ─── dispose ────────────────────────────────────────────────────────────

  describe('dispose', () => {
    it('unsubscribes from bridge after dispose', () => {
      const conn = fakeConnection('c1', 's1');
      registry.register(conn);
      registry.addSubscription('c1', 'conv-1');

      forwarder.dispose();

      bridge.emitStreamEvent('conv-1', makeEvent(99));

      // No delivery after dispose
      assert.equal(conn.sent.length, 0);
      // Buffer should also not be populated after dispose
      const buffered = buffer.getEventsSince('conv-1', 0);
      assert.equal(buffered.length, 0);
    });
  });
});
