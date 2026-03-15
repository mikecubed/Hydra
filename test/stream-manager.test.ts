/**
 * Unit tests for StreamManager — turn stream lifecycle management.
 *
 * Covers: create stream, emit events, complete, fail, subscribe from midpoint,
 * lifecycle signals, and turn content finalization.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { StreamManager } from '../lib/daemon/stream-manager.ts';
import { ConversationStore } from '../lib/daemon/conversation-store.ts';

const operatorAttribution = { type: 'operator' as const, label: 'Admin' };

let store: ConversationStore;
let streamManager: StreamManager;

beforeEach(() => {
  store = new ConversationStore();
  streamManager = new StreamManager(store);
});

// ── Stream lifecycle ─────────────────────────────────────────────────────────

describe('StreamManager — lifecycle', () => {
  it('creates a stream for a turn', () => {
    const conv = store.createConversation();
    const turn = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Hello',
      attribution: operatorAttribution,
    });
    const streamId = streamManager.createStream(turn.id);
    assert.ok(streamId, 'should return a stream id');
  });

  it('emits stream-started on creation', () => {
    const conv = store.createConversation();
    const turn = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Hello',
      attribution: operatorAttribution,
    });
    streamManager.createStream(turn.id);
    const events = streamManager.getStreamEvents(turn.id);
    assert.ok(events.length >= 1);
    assert.equal(events[0].kind, 'stream-started');
  });

  it('emits text-delta events', () => {
    const conv = store.createConversation();
    const turn = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Hello',
      attribution: operatorAttribution,
    });
    streamManager.createStream(turn.id);
    streamManager.emitEvent(turn.id, 'text-delta', { text: 'chunk 1' });
    streamManager.emitEvent(turn.id, 'text-delta', { text: 'chunk 2' });
    const events = streamManager.getStreamEvents(turn.id);
    const deltas = events.filter((e) => e.kind === 'text-delta');
    assert.equal(deltas.length, 2);
  });

  it('emits stream-completed on completion', () => {
    const conv = store.createConversation();
    const turn = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Hello',
      attribution: operatorAttribution,
    });
    streamManager.createStream(turn.id);
    streamManager.emitEvent(turn.id, 'text-delta', { text: 'response' });
    streamManager.completeStream(turn.id);

    const events = streamManager.getStreamEvents(turn.id);
    const completed = events.find((e) => e.kind === 'stream-completed');
    assert.ok(completed, 'should have a stream-completed event');
  });

  it('emits stream-failed on failure', () => {
    const conv = store.createConversation();
    const turn = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Hello',
      attribution: operatorAttribution,
    });
    streamManager.createStream(turn.id);
    streamManager.failStream(turn.id, 'Something went wrong');

    const events = streamManager.getStreamEvents(turn.id);
    const failed = events.find((e) => e.kind === 'stream-failed');
    assert.ok(failed, 'should have a stream-failed event');
  });

  it('assigns monotonically increasing sequence numbers', () => {
    const conv = store.createConversation();
    const turn = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Hello',
      attribution: operatorAttribution,
    });
    streamManager.createStream(turn.id);
    streamManager.emitEvent(turn.id, 'text-delta', { text: 'a' });
    streamManager.emitEvent(turn.id, 'text-delta', { text: 'b' });

    const events = streamManager.getStreamEvents(turn.id);
    for (let i = 1; i < events.length; i++) {
      assert.ok(events[i].seq > events[i - 1].seq, 'seq should be strictly increasing');
    }
  });
});

// ── Stream subscription (from midpoint) ──────────────────────────────────────

describe('StreamManager — subscription', () => {
  it('subscribes from beginning (lastSeq=0)', () => {
    const conv = store.createConversation();
    const turn = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Hello',
      attribution: operatorAttribution,
    });
    streamManager.createStream(turn.id);
    streamManager.emitEvent(turn.id, 'text-delta', { text: 'a' });
    streamManager.emitEvent(turn.id, 'text-delta', { text: 'b' });

    const events = streamManager.getStreamEventsSince(turn.id, 0);
    assert.ok(events.length >= 3, 'should include started + 2 deltas');
  });

  it('subscribes from midpoint (exclusive)', () => {
    const conv = store.createConversation();
    const turn = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Hello',
      attribution: operatorAttribution,
    });
    streamManager.createStream(turn.id);
    streamManager.emitEvent(turn.id, 'text-delta', { text: 'a' });
    streamManager.emitEvent(turn.id, 'text-delta', { text: 'b' });
    streamManager.emitEvent(turn.id, 'text-delta', { text: 'c' });

    const allEvents = streamManager.getStreamEvents(turn.id);
    const midSeq = allEvents[1].seq; // after 'started' and first delta
    const fromMid = streamManager.getStreamEventsSince(turn.id, midSeq);
    assert.ok(fromMid.length < allEvents.length, 'should have fewer events when resuming');
    assert.ok(
      fromMid.every((e) => e.seq > midSeq),
      'all events should be strictly after midpoint (exclusive)',
    );
  });

  it('since is exclusive — does not duplicate last acknowledged event', () => {
    const conv = store.createConversation();
    const turn = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Hello',
      attribution: operatorAttribution,
    });
    streamManager.createStream(turn.id);
    streamManager.emitEvent(turn.id, 'text-delta', { text: 'a' });
    streamManager.emitEvent(turn.id, 'text-delta', { text: 'b' });

    const allEvents = streamManager.getStreamEvents(turn.id);
    const lastAcked = allEvents.at(-1)!.seq;
    const resumed = streamManager.getStreamEventsSince(turn.id, lastAcked);
    assert.equal(resumed.length, 0, 'no events should be returned when fully caught up');
  });
});

// ── Turn content finalization ────────────────────────────────────────────────

describe('StreamManager — turn finalization', () => {
  it('consolidates text-delta events into turn response on completion', () => {
    const conv = store.createConversation();
    const turn = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Hello',
      attribution: operatorAttribution,
    });
    store.updateTurnStatus(turn.id, 'executing');
    streamManager.createStream(turn.id);
    streamManager.emitEvent(turn.id, 'text-delta', { text: 'Hello ' });
    streamManager.emitEvent(turn.id, 'text-delta', { text: 'World' });
    streamManager.completeStream(turn.id);

    const finalTurn = store.getTurn(turn.id);
    assert.equal(finalTurn?.response, 'Hello World');
    assert.equal(finalTurn?.status, 'completed');
  });

  it('sets turn to failed on stream failure', () => {
    const conv = store.createConversation();
    const turn = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Hello',
      attribution: operatorAttribution,
    });
    store.updateTurnStatus(turn.id, 'executing');
    streamManager.createStream(turn.id);
    streamManager.failStream(turn.id, 'Error occurred');

    const finalTurn = store.getTurn(turn.id);
    assert.equal(finalTurn?.status, 'failed');
  });
});

// ── Cancellation ─────────────────────────────────────────────────────────────

describe('StreamManager — cancellation', () => {
  it('cancels an active stream', () => {
    const conv = store.createConversation();
    const turn = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Hello',
      attribution: operatorAttribution,
    });
    store.updateTurnStatus(turn.id, 'executing');
    streamManager.createStream(turn.id);
    streamManager.emitEvent(turn.id, 'text-delta', { text: 'partial' });
    streamManager.cancelStream(turn.id);

    const events = streamManager.getStreamEvents(turn.id);
    const cancel = events.find((e) => e.kind === 'cancellation');
    assert.ok(cancel, 'should emit cancellation event');

    const finalTurn = store.getTurn(turn.id);
    assert.equal(finalTurn?.status, 'cancelled');
  });

  it('is idempotent — cancelling already-completed stream is no-op', () => {
    const conv = store.createConversation();
    const turn = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Hello',
      attribution: operatorAttribution,
    });
    store.updateTurnStatus(turn.id, 'executing');
    streamManager.createStream(turn.id);
    streamManager.completeStream(turn.id);

    // Cancel after completion should not throw
    streamManager.cancelStream(turn.id);
    const finalTurn = store.getTurn(turn.id);
    assert.equal(finalTurn?.status, 'completed', 'should remain completed');
  });
});

// ── Approval and activity event integration ──────────────────────────────────

describe('StreamManager — approval and activity events', () => {
  it('emits approval-prompt event', () => {
    const conv = store.createConversation();
    const turn = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Hello',
      attribution: operatorAttribution,
    });
    streamManager.createStream(turn.id);
    streamManager.emitEvent(turn.id, 'approval-prompt', { approvalId: 'a-1' });

    const events = streamManager.getStreamEvents(turn.id);
    const approval = events.find((e) => e.kind === 'approval-prompt');
    assert.ok(approval, 'should have an approval-prompt event');
  });

  it('emits approval-response event', () => {
    const conv = store.createConversation();
    const turn = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Hello',
      attribution: operatorAttribution,
    });
    streamManager.createStream(turn.id);
    streamManager.emitEvent(turn.id, 'approval-response', {
      approvalId: 'a-1',
      response: 'approve',
    });

    const events = streamManager.getStreamEvents(turn.id);
    const response = events.find((e) => e.kind === 'approval-response');
    assert.ok(response, 'should have an approval-response event');
  });

  it('emits activity-marker event', () => {
    const conv = store.createConversation();
    const turn = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Hello',
      attribution: operatorAttribution,
    });
    streamManager.createStream(turn.id);
    streamManager.emitEvent(turn.id, 'activity-marker', {
      agentId: 'gemini',
      description: 'Analyzing...',
    });

    const events = streamManager.getStreamEvents(turn.id);
    const marker = events.find((e) => e.kind === 'activity-marker');
    assert.ok(marker, 'should have an activity-marker event');
  });

  it('emits artifact-notice event', () => {
    const conv = store.createConversation();
    const turn = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Hello',
      attribution: operatorAttribution,
    });
    streamManager.createStream(turn.id);
    streamManager.emitEvent(turn.id, 'artifact-notice', {
      artifactId: 'art-1',
      kind: 'file',
      label: 'output.ts',
    });

    const events = streamManager.getStreamEvents(turn.id);
    const notice = events.find((e) => e.kind === 'artifact-notice');
    assert.ok(notice, 'should have an artifact-notice event');
  });
});

// ── Stream status queries ────────────────────────────────────────────────────

describe('StreamManager — status', () => {
  it('reports active stream', () => {
    const conv = store.createConversation();
    const turn = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Hello',
      attribution: operatorAttribution,
    });
    streamManager.createStream(turn.id);
    assert.ok(streamManager.isStreamActive(turn.id));
  });

  it('reports completed stream as inactive', () => {
    const conv = store.createConversation();
    const turn = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Hello',
      attribution: operatorAttribution,
    });
    store.updateTurnStatus(turn.id, 'executing');
    streamManager.createStream(turn.id);
    streamManager.completeStream(turn.id);
    assert.ok(!streamManager.isStreamActive(turn.id));
  });
});

// ── Stream retention / cleanup ───────────────────────────────────────────────

describe('StreamManager — retention', () => {
  it('purgeTerminalStreams removes completed streams past retention window', () => {
    // Use large retention so auto-purge does not fire, then manually purge with 0ms
    const sm = new StreamManager(store, 60_000);
    const conv = store.createConversation();
    const turn = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Hello',
      attribution: operatorAttribution,
    });
    store.updateTurnStatus(turn.id, 'executing');
    sm.createStream(turn.id);
    sm.completeStream(turn.id);

    assert.equal(sm.streamCount, 1, 'stream should be retained within window');

    // Manual purge with 0ms override should remove it
    const purged = sm.purgeTerminalStreams(0);
    assert.equal(purged, 1);
    assert.equal(sm.streamCount, 0);
    assert.deepStrictEqual(sm.getStreamEvents(turn.id), []);
  });

  it('purgeTerminalStreams preserves active streams', () => {
    const sm = new StreamManager(store, 0);
    const conv = store.createConversation();
    const turn = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Hello',
      attribution: operatorAttribution,
    });
    sm.createStream(turn.id);

    const purged = sm.purgeTerminalStreams(0);
    assert.equal(purged, 0);
    assert.equal(sm.streamCount, 1);
  });

  it('purgeTerminalStreams preserves streams within retention window', () => {
    // Use very large retention so nothing expires
    const sm = new StreamManager(store, 60_000);
    const conv = store.createConversation();
    const turn = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Hello',
      attribution: operatorAttribution,
    });
    store.updateTurnStatus(turn.id, 'executing');
    sm.createStream(turn.id);
    sm.completeStream(turn.id);

    const purged = sm.purgeTerminalStreams();
    assert.equal(purged, 0, 'recently completed stream should not be purged');
    assert.equal(sm.streamCount, 1);
  });

  it('auto-purges on completeStream with 0ms retention', () => {
    const sm = new StreamManager(store, 0);
    const conv = store.createConversation();

    // Create and complete stream A
    const turnA = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });
    store.updateTurnStatus(turnA.id, 'executing');
    sm.createStream(turnA.id);
    sm.completeStream(turnA.id);

    // Create and complete stream B — this should auto-purge A
    const turnB = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'B',
      attribution: operatorAttribution,
    });
    store.updateTurnStatus(turnB.id, 'executing');
    sm.createStream(turnB.id);
    sm.completeStream(turnB.id);

    // Both terminal with 0ms retention — both purged at B's completion
    assert.equal(sm.streamCount, 0);
  });

  it('auto-purges on failStream', () => {
    const sm = new StreamManager(store, 0);
    const conv = store.createConversation();

    const turnA = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });
    store.updateTurnStatus(turnA.id, 'executing');
    sm.createStream(turnA.id);
    sm.completeStream(turnA.id);

    const turnB = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'B',
      attribution: operatorAttribution,
    });
    store.updateTurnStatus(turnB.id, 'executing');
    sm.createStream(turnB.id);
    sm.failStream(turnB.id, 'error');

    assert.equal(sm.streamCount, 0);
  });

  it('auto-purges on cancelStream', () => {
    const sm = new StreamManager(store, 0);
    const conv = store.createConversation();

    const turnA = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });
    store.updateTurnStatus(turnA.id, 'executing');
    sm.createStream(turnA.id);
    sm.completeStream(turnA.id);

    const turnB = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'B',
      attribution: operatorAttribution,
    });
    store.updateTurnStatus(turnB.id, 'executing');
    sm.createStream(turnB.id);
    sm.cancelStream(turnB.id);

    assert.equal(sm.streamCount, 0);
  });

  it('streamCount reflects current map size', () => {
    const conv = store.createConversation();
    assert.equal(streamManager.streamCount, 0);

    const turn = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Hello',
      attribution: operatorAttribution,
    });
    streamManager.createStream(turn.id);
    assert.equal(streamManager.streamCount, 1);
  });
});
