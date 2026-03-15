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

  it('subscribes from midpoint', () => {
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
    const fromMid = streamManager.getStreamEventsSince(turn.id, midSeq + 1);
    assert.ok(fromMid.length < allEvents.length, 'should have fewer events when resuming');
    assert.ok(
      fromMid.every((e) => e.seq > midSeq),
      'all events should be after midpoint',
    );
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
