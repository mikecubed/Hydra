import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { StreamEvent } from '@hydra/web-contracts';

import type { TranscriptEntryState } from '../model/workspace-types.ts';
import {
  createReconcilerState,
  isStaleEvent,
  reconcileStreamEvents,
  findEntryByTurnId,
  appendTextDelta,
  type ReconcilerState,
} from '../model/reconciler.ts';

// ─── Factories ──────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<StreamEvent> & { seq: number; turnId: string }): StreamEvent {
  return {
    kind: 'text-delta',
    payload: {},
    timestamp: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeEntry(overrides: Partial<TranscriptEntryState> = {}): TranscriptEntryState {
  return {
    entryId: 'entry-1',
    kind: 'turn',
    turnId: 'turn-1',
    status: 'completed',
    timestamp: '2026-07-01T00:00:00.000Z',
    contentBlocks: [],
    artifacts: [],
    controls: [],
    prompt: null,
    ...overrides,
  };
}

function stateWithHighWater(pairs: ReadonlyArray<[string, number]>): ReconcilerState {
  return { highWaterSeq: new Map(pairs) };
}

// ─── createReconcilerState ──────────────────────────────────────────────────

describe('createReconcilerState', () => {
  it('returns empty high-water map', () => {
    const s = createReconcilerState();
    assert.deepStrictEqual(s.highWaterSeq, new Map());
  });
});

// ─── isStaleEvent ───────────────────────────────────────────────────────────

describe('isStaleEvent', () => {
  it('returns false for a fresh event with no prior high-water', () => {
    const event = makeEvent({ seq: 0, turnId: 'turn-a' });
    assert.equal(isStaleEvent(event, createReconcilerState()), false);
  });

  it('returns false when seq exceeds high-water for the turn', () => {
    const event = makeEvent({ seq: 5, turnId: 'turn-a' });
    const state = stateWithHighWater([['turn-a', 3]]);
    assert.equal(isStaleEvent(event, state), false);
  });

  it('returns true when seq equals high-water for the turn', () => {
    const event = makeEvent({ seq: 3, turnId: 'turn-a' });
    const state = stateWithHighWater([['turn-a', 3]]);
    assert.equal(isStaleEvent(event, state), true);
  });

  it('returns true when seq is below high-water for the turn', () => {
    const event = makeEvent({ seq: 1, turnId: 'turn-a' });
    const state = stateWithHighWater([['turn-a', 3]]);
    assert.equal(isStaleEvent(event, state), true);
  });

  it('is independent per turnId', () => {
    const state = stateWithHighWater([['turn-a', 10]]);
    assert.equal(isStaleEvent(makeEvent({ seq: 0, turnId: 'turn-b' }), state), false);
    assert.equal(isStaleEvent(makeEvent({ seq: 10, turnId: 'turn-a' }), state), true);
  });
});

// ─── findEntryByTurnId ──────────────────────────────────────────────────────

describe('findEntryByTurnId', () => {
  it('returns undefined for empty entries', () => {
    assert.equal(findEntryByTurnId([], 'turn-1'), undefined);
  });

  it('finds the first entry matching the turnId', () => {
    const entries = [makeEntry({ entryId: 'e1', turnId: 'turn-1' })];
    assert.equal(findEntryByTurnId(entries, 'turn-1')?.entryId, 'e1');
  });

  it('returns undefined when no entry matches', () => {
    const entries = [makeEntry({ entryId: 'e1', turnId: 'turn-1' })];
    assert.equal(findEntryByTurnId(entries, 'turn-99'), undefined);
  });
});

// ─── appendTextDelta ────────────────────────────────────────────────────────

describe('appendTextDelta', () => {
  it('appends to an existing text block matching blockId', () => {
    const entry = makeEntry({
      contentBlocks: [{ blockId: 'blk-1', kind: 'text', text: 'Hello', metadata: null }],
    });
    const result = appendTextDelta(entry, ' world', 'blk-1');
    assert.equal(result.contentBlocks.length, 1);
    assert.equal(result.contentBlocks[0].text, 'Hello world');
  });

  it('creates a new block when blockId is absent from entry', () => {
    const entry = makeEntry({ contentBlocks: [] });
    const result = appendTextDelta(entry, 'first chunk', 'blk-new');
    assert.equal(result.contentBlocks.length, 1);
    assert.equal(result.contentBlocks[0].blockId, 'blk-new');
    assert.equal(result.contentBlocks[0].text, 'first chunk');
    assert.equal(result.contentBlocks[0].kind, 'text');
  });

  it('uses a default blockId derived from turnId when none provided', () => {
    const entry = makeEntry({ turnId: 'turn-42', contentBlocks: [] });
    const result = appendTextDelta(entry, 'delta');
    assert.equal(result.contentBlocks.length, 1);
    assert.equal(result.contentBlocks[0].blockId, 'turn-42-streaming');
  });

  it('does not mutate the original entry', () => {
    const entry = makeEntry({
      contentBlocks: [{ blockId: 'blk-1', kind: 'text', text: 'a', metadata: null }],
    });
    appendTextDelta(entry, 'b', 'blk-1');
    assert.equal(entry.contentBlocks[0].text, 'a');
  });

  it('initialises text from null when block exists with null text', () => {
    const entry = makeEntry({
      contentBlocks: [{ blockId: 'blk-1', kind: 'text', text: null, metadata: null }],
    });
    const result = appendTextDelta(entry, 'start', 'blk-1');
    assert.equal(result.contentBlocks[0].text, 'start');
  });
});

// ─── reconcileStreamEvents — core reconciliation ────────────────────────────

describe('reconcileStreamEvents', () => {
  it('returns entries and state unchanged for empty events', () => {
    const entries = [makeEntry()];
    const state = createReconcilerState();
    const result = reconcileStreamEvents(entries, [], state);
    assert.deepStrictEqual(result.entries, entries);
    assert.deepStrictEqual(result.state, state);
  });

  // ── stream-started ──────────────────────────────────────────────────────

  describe('stream-started', () => {
    it('creates a new entry with streaming status', () => {
      const event = makeEvent({
        seq: 0,
        turnId: 'turn-new',
        kind: 'stream-started',
        payload: {},
      });
      const { entries } = reconcileStreamEvents([], [event], createReconcilerState());
      assert.equal(entries.length, 1);
      assert.equal(entries[0].entryId, 'turn-new');
      assert.equal(entries[0].kind, 'turn');
      assert.equal(entries[0].turnId, 'turn-new');
      assert.equal(entries[0].status, 'streaming');
    });

    it('preserves attribution label from payload', () => {
      const event = makeEvent({
        seq: 0,
        turnId: 'turn-new',
        kind: 'stream-started',
        payload: { attribution: 'claude' },
      });
      const { entries } = reconcileStreamEvents([], [event], createReconcilerState());
      assert.equal(entries[0].attributionLabel, 'claude');
    });

    it('does not duplicate an existing entry for the same turnId', () => {
      const existing = makeEntry({ entryId: 'turn-x', turnId: 'turn-x', status: 'streaming' });
      const event = makeEvent({
        seq: 1,
        turnId: 'turn-x',
        kind: 'stream-started',
        payload: {},
      });
      const { entries } = reconcileStreamEvents([existing], [event], createReconcilerState());
      assert.equal(entries.length, 1);
      assert.equal(entries[0].status, 'streaming');
    });
  });

  // ── text-delta ──────────────────────────────────────────────────────────

  describe('text-delta', () => {
    it('appends text to the matching turn entry', () => {
      const existing = makeEntry({
        entryId: 'turn-1',
        turnId: 'turn-1',
        status: 'streaming',
        contentBlocks: [],
      });
      const events = [
        makeEvent({ seq: 1, turnId: 'turn-1', kind: 'text-delta', payload: { text: 'Hello' } }),
        makeEvent({ seq: 2, turnId: 'turn-1', kind: 'text-delta', payload: { text: ' world' } }),
      ];
      const { entries } = reconcileStreamEvents([existing], events, createReconcilerState());
      assert.equal(entries[0].contentBlocks[0].text, 'Hello world');
    });

    it('creates a placeholder entry when turn is not yet known', () => {
      const event = makeEvent({
        seq: 1,
        turnId: 'turn-unknown',
        kind: 'text-delta',
        payload: { text: 'early' },
      });
      const { entries } = reconcileStreamEvents([], [event], createReconcilerState());
      assert.equal(entries.length, 1);
      assert.equal(entries[0].turnId, 'turn-unknown');
      assert.equal(entries[0].status, 'streaming');
      assert.equal(entries[0].contentBlocks[0].text, 'early');
    });

    it('targets a specific blockId from payload', () => {
      const existing = makeEntry({
        entryId: 'turn-1',
        turnId: 'turn-1',
        status: 'streaming',
        contentBlocks: [{ blockId: 'custom-blk', kind: 'text', text: 'pre-', metadata: null }],
      });
      const event = makeEvent({
        seq: 1,
        turnId: 'turn-1',
        kind: 'text-delta',
        payload: { text: 'fix', blockId: 'custom-blk' },
      });
      const { entries } = reconcileStreamEvents([existing], [event], createReconcilerState());
      assert.equal(entries[0].contentBlocks[0].text, 'pre-fix');
    });
  });

  // ── status-change ─────────────────────────────────────────────────────

  describe('status-change', () => {
    it('updates the entry status', () => {
      const existing = makeEntry({
        entryId: 'turn-1',
        turnId: 'turn-1',
        status: 'streaming',
      });
      const event = makeEvent({
        seq: 1,
        turnId: 'turn-1',
        kind: 'status-change',
        payload: { status: 'awaiting-approval' },
      });
      const { entries } = reconcileStreamEvents([existing], [event], createReconcilerState());
      assert.equal(entries[0].status, 'awaiting-approval');
    });
  });

  // ── stream-completed ──────────────────────────────────────────────────

  describe('stream-completed', () => {
    it('sets status to completed', () => {
      const existing = makeEntry({
        entryId: 'turn-1',
        turnId: 'turn-1',
        status: 'streaming',
      });
      const event = makeEvent({
        seq: 5,
        turnId: 'turn-1',
        kind: 'stream-completed',
        payload: {},
      });
      const { entries } = reconcileStreamEvents([existing], [event], createReconcilerState());
      assert.equal(entries[0].status, 'completed');
    });

    it('respects custom final status from payload', () => {
      const existing = makeEntry({
        entryId: 'turn-1',
        turnId: 'turn-1',
        status: 'streaming',
      });
      const event = makeEvent({
        seq: 5,
        turnId: 'turn-1',
        kind: 'stream-completed',
        payload: { status: 'completed-partial' },
      });
      const { entries } = reconcileStreamEvents([existing], [event], createReconcilerState());
      assert.equal(entries[0].status, 'completed-partial');
    });
  });

  // ── stream-failed ─────────────────────────────────────────────────────

  describe('stream-failed', () => {
    it('sets status to failed', () => {
      const existing = makeEntry({
        entryId: 'turn-1',
        turnId: 'turn-1',
        status: 'streaming',
      });
      const event = makeEvent({
        seq: 5,
        turnId: 'turn-1',
        kind: 'stream-failed',
        payload: { reason: 'timeout' },
      });
      const { entries } = reconcileStreamEvents([existing], [event], createReconcilerState());
      assert.equal(entries[0].status, 'failed');
    });

    it('appends an error content block when reason is present', () => {
      const existing = makeEntry({
        entryId: 'turn-1',
        turnId: 'turn-1',
        status: 'streaming',
        contentBlocks: [],
      });
      const event = makeEvent({
        seq: 5,
        turnId: 'turn-1',
        kind: 'stream-failed',
        payload: { reason: 'connection lost' },
      });
      const { entries } = reconcileStreamEvents([existing], [event], createReconcilerState());
      const errorBlock = entries[0].contentBlocks.find((b) => b.kind === 'status');
      assert.ok(errorBlock);
      assert.equal(errorBlock.text, 'connection lost');
    });
  });

  // ── activity-marker ───────────────────────────────────────────────────

  describe('activity-marker', () => {
    it('creates an activity-group entry', () => {
      const event = makeEvent({
        seq: 1,
        turnId: 'turn-1',
        kind: 'activity-marker',
        payload: { description: 'Searching files…' },
      });
      const { entries } = reconcileStreamEvents([], [event], createReconcilerState());
      const activity = entries.find((e) => e.kind === 'activity-group');
      assert.ok(activity);
      assert.equal(activity.contentBlocks[0].text, 'Searching files…');
    });

    it('updates an existing activity-group for the same turn', () => {
      const events = [
        makeEvent({
          seq: 1,
          turnId: 'turn-1',
          kind: 'activity-marker',
          payload: { description: 'Step 1' },
        }),
        makeEvent({
          seq: 2,
          turnId: 'turn-1',
          kind: 'activity-marker',
          payload: { description: 'Step 2' },
        }),
      ];
      const { entries } = reconcileStreamEvents([], events, createReconcilerState());
      const activities = entries.filter((e) => e.kind === 'activity-group');
      assert.equal(activities.length, 1);
      assert.equal(activities[0].contentBlocks.length, 2);
    });
  });

  // ── approval-prompt ───────────────────────────────────────────────────

  describe('approval-prompt', () => {
    it('attaches a prompt to the matching turn entry', () => {
      const existing = makeEntry({
        entryId: 'turn-1',
        turnId: 'turn-1',
        status: 'streaming',
      });
      const event = makeEvent({
        seq: 3,
        turnId: 'turn-1',
        kind: 'approval-prompt',
        payload: {
          approvalId: 'prompt-1',
          allowedResponses: ['approve', 'reject'],
          context: 'Delete foo.ts?',
        },
      });
      const { entries } = reconcileStreamEvents([existing], [event], createReconcilerState());
      assert.ok(entries[0].prompt);
      assert.equal(entries[0].prompt?.promptId, 'prompt-1');
      assert.equal(entries[0].prompt?.status, 'pending');
      assert.deepStrictEqual(entries[0].prompt?.allowedResponses, ['approve', 'reject']);
    });
  });

  // ── approval-response ─────────────────────────────────────────────────

  describe('approval-response', () => {
    it('resolves prompt when approvalId matches promptId', () => {
      const existing = makeEntry({
        entryId: 'turn-1',
        turnId: 'turn-1',
        status: 'streaming',
        prompt: {
          promptId: 'prompt-1',
          parentTurnId: 'turn-1',
          status: 'pending',
          allowedResponses: ['approve', 'reject'],
          contextBlocks: [],
          lastResponseSummary: null,
        },
      });
      const event = makeEvent({
        seq: 4,
        turnId: 'turn-1',
        kind: 'approval-response',
        payload: { approvalId: 'prompt-1', response: 'approve' },
      });
      const { entries } = reconcileStreamEvents([existing], [event], createReconcilerState());
      assert.equal(entries[0].prompt?.status, 'resolved');
      assert.equal(entries[0].prompt?.lastResponseSummary, 'approve');
    });

    it('ignores approval-response when approvalId does not match promptId', () => {
      const existing = makeEntry({
        entryId: 'turn-1',
        turnId: 'turn-1',
        status: 'streaming',
        prompt: {
          promptId: 'prompt-1',
          parentTurnId: 'turn-1',
          status: 'pending',
          allowedResponses: ['approve', 'reject'],
          contextBlocks: [],
          lastResponseSummary: null,
        },
      });
      const event = makeEvent({
        seq: 4,
        turnId: 'turn-1',
        kind: 'approval-response',
        payload: { approvalId: 'foreign-prompt-99', response: 'approve' },
      });
      const { entries } = reconcileStreamEvents([existing], [event], createReconcilerState());
      assert.equal(entries[0].prompt?.status, 'pending');
      assert.equal(entries[0].prompt?.lastResponseSummary, null);
    });

    it('ignores out-of-order approval-response for a different prompt cycle', () => {
      const existing = makeEntry({
        entryId: 'turn-1',
        turnId: 'turn-1',
        status: 'streaming',
        prompt: {
          promptId: 'prompt-2',
          parentTurnId: 'turn-1',
          status: 'pending',
          allowedResponses: ['yes', 'no'],
          contextBlocks: [],
          lastResponseSummary: null,
        },
      });
      const staleResponse = makeEvent({
        seq: 5,
        turnId: 'turn-1',
        kind: 'approval-response',
        payload: { approvalId: 'prompt-1', response: 'yes' },
      });
      const { entries } = reconcileStreamEvents(
        [existing],
        [staleResponse],
        createReconcilerState(),
      );
      assert.equal(entries[0].prompt?.status, 'pending');
      assert.equal(entries[0].prompt?.promptId, 'prompt-2');
    });

    it('does not create a ghost turn entry when no matching turn exists', () => {
      const event = makeEvent({
        seq: 1,
        turnId: 'unknown-turn',
        kind: 'approval-response',
        payload: { approvalId: 'prompt-1', response: 'approve' },
      });
      const { entries } = reconcileStreamEvents([], [event], createReconcilerState());
      assert.equal(entries.length, 0, 'approval-response for absent turn must not create entries');
    });

    it('does not create a ghost turn entry when turnId exists but has no prompt', () => {
      const existing = makeEntry({
        entryId: 'turn-1',
        turnId: 'turn-1',
        status: 'streaming',
        prompt: null,
      });
      const event = makeEvent({
        seq: 2,
        turnId: 'turn-1',
        kind: 'approval-response',
        payload: { approvalId: 'prompt-1', response: 'approve' },
      });
      const { entries } = reconcileStreamEvents([existing], [event], createReconcilerState());
      assert.equal(entries.length, 1);
      assert.equal(entries[0].prompt, null, 'prompt must remain null when no prompt was set');
    });
  });

  // ── artifact-notice ───────────────────────────────────────────────────

  describe('artifact-notice', () => {
    it('adds an artifact reference to the matching entry', () => {
      const existing = makeEntry({
        entryId: 'turn-1',
        turnId: 'turn-1',
        status: 'streaming',
        artifacts: [],
      });
      const event = makeEvent({
        seq: 3,
        turnId: 'turn-1',
        kind: 'artifact-notice',
        payload: { artifactId: 'art-1', kind: 'file', label: 'index.ts' },
      });
      const { entries } = reconcileStreamEvents([existing], [event], createReconcilerState());
      assert.equal(entries[0].artifacts.length, 1);
      assert.equal(entries[0].artifacts[0].artifactId, 'art-1');
      assert.equal(entries[0].artifacts[0].label, 'index.ts');
    });

    it('does not duplicate an artifact with the same id', () => {
      const existing = makeEntry({
        entryId: 'turn-1',
        turnId: 'turn-1',
        status: 'streaming',
        artifacts: [
          { artifactId: 'art-1', kind: 'file', label: 'index.ts', availability: 'listed' },
        ],
      });
      const event = makeEvent({
        seq: 3,
        turnId: 'turn-1',
        kind: 'artifact-notice',
        payload: { artifactId: 'art-1', kind: 'file', label: 'index.ts updated' },
      });
      const { entries } = reconcileStreamEvents([existing], [event], createReconcilerState());
      assert.equal(entries[0].artifacts.length, 1);
      assert.equal(entries[0].artifacts[0].label, 'index.ts updated');
    });
  });

  // ── cancellation ──────────────────────────────────────────────────────

  describe('cancellation', () => {
    it('sets entry status to cancelled', () => {
      const existing = makeEntry({
        entryId: 'turn-1',
        turnId: 'turn-1',
        status: 'streaming',
      });
      const event = makeEvent({
        seq: 5,
        turnId: 'turn-1',
        kind: 'cancellation',
        payload: { reason: 'user requested' },
      });
      const { entries } = reconcileStreamEvents([existing], [event], createReconcilerState());
      assert.equal(entries[0].status, 'cancelled');
    });
  });

  // ── warning ───────────────────────────────────────────────────────────

  describe('warning', () => {
    it('creates a system-status entry', () => {
      const event = makeEvent({
        seq: 1,
        turnId: 'turn-1',
        kind: 'warning',
        payload: { message: 'Rate limit approaching' },
      });
      const { entries } = reconcileStreamEvents([], [event], createReconcilerState());
      const sys = entries.find((e) => e.kind === 'system-status');
      assert.ok(sys);
      assert.equal(sys.status, 'warning');
      assert.equal(sys.contentBlocks[0].text, 'Rate limit approaching');
    });
  });

  // ── error ─────────────────────────────────────────────────────────────

  describe('error', () => {
    it('creates a system-status entry with error status', () => {
      const event = makeEvent({
        seq: 1,
        turnId: 'turn-1',
        kind: 'error',
        payload: { message: 'Internal error' },
      });
      const { entries } = reconcileStreamEvents([], [event], createReconcilerState());
      const sys = entries.find((e) => e.kind === 'system-status');
      assert.ok(sys);
      assert.equal(sys.status, 'error');
      assert.equal(sys.contentBlocks[0].text, 'Internal error');
    });
  });

  // ── checkpoint ────────────────────────────────────────────────────────

  describe('checkpoint', () => {
    it('advances high-water seq without modifying entries', () => {
      const existing = makeEntry({ entryId: 'turn-1', turnId: 'turn-1' });
      const event = makeEvent({
        seq: 99,
        turnId: 'turn-1',
        kind: 'checkpoint',
        payload: {},
      });
      const { entries, state } = reconcileStreamEvents(
        [existing],
        [event],
        createReconcilerState(),
      );
      assert.equal(entries.length, 1);
      assert.equal(entries[0], existing);
      assert.equal(state.highWaterSeq.get('turn-1'), 99);
    });
  });

  // ── duplicate suppression ─────────────────────────────────────────────

  describe('duplicate suppression', () => {
    it('skips events at or below the high-water mark', () => {
      const existing = makeEntry({
        entryId: 'turn-1',
        turnId: 'turn-1',
        status: 'streaming',
        contentBlocks: [
          { blockId: 'turn-1-streaming', kind: 'text', text: 'original', metadata: null },
        ],
      });
      const state = stateWithHighWater([['turn-1', 5]]);
      const events = [
        makeEvent({
          seq: 3,
          turnId: 'turn-1',
          kind: 'text-delta',
          payload: { text: ' stale' },
        }),
        makeEvent({
          seq: 5,
          turnId: 'turn-1',
          kind: 'text-delta',
          payload: { text: ' also-stale' },
        }),
        makeEvent({
          seq: 6,
          turnId: 'turn-1',
          kind: 'text-delta',
          payload: { text: ' fresh' },
        }),
      ];
      const { entries } = reconcileStreamEvents([existing], events, state);
      assert.equal(entries[0].contentBlocks[0].text, 'original fresh');
    });

    it('tracks high-water per turn independently', () => {
      const events = [
        makeEvent({
          seq: 1,
          turnId: 'turn-a',
          kind: 'stream-started',
          payload: {},
        }),
        makeEvent({
          seq: 10,
          turnId: 'turn-b',
          kind: 'stream-started',
          payload: {},
        }),
      ];
      const { state } = reconcileStreamEvents([], events, createReconcilerState());
      assert.equal(state.highWaterSeq.get('turn-a'), 1);
      assert.equal(state.highWaterSeq.get('turn-b'), 10);
    });
  });

  // ── multi-event batch ordering ────────────────────────────────────────

  describe('batch ordering', () => {
    it('applies events sequentially to build complete entry', () => {
      const events: StreamEvent[] = [
        makeEvent({ seq: 0, turnId: 't1', kind: 'stream-started', payload: {} }),
        makeEvent({ seq: 1, turnId: 't1', kind: 'text-delta', payload: { text: 'Hello' } }),
        makeEvent({ seq: 2, turnId: 't1', kind: 'text-delta', payload: { text: ' world' } }),
        makeEvent({ seq: 3, turnId: 't1', kind: 'stream-completed', payload: {} }),
      ];
      const { entries, state } = reconcileStreamEvents([], events, createReconcilerState());
      assert.equal(entries.length, 1);
      assert.equal(entries[0].status, 'completed');
      assert.equal(entries[0].contentBlocks[0].text, 'Hello world');
      assert.equal(state.highWaterSeq.get('t1'), 3);
    });

    it('handles interleaved events for different turns', () => {
      const events: StreamEvent[] = [
        makeEvent({ seq: 0, turnId: 'a', kind: 'stream-started', payload: {} }),
        makeEvent({ seq: 0, turnId: 'b', kind: 'stream-started', payload: {} }),
        makeEvent({ seq: 1, turnId: 'a', kind: 'text-delta', payload: { text: 'A-text' } }),
        makeEvent({ seq: 1, turnId: 'b', kind: 'text-delta', payload: { text: 'B-text' } }),
        makeEvent({ seq: 2, turnId: 'a', kind: 'stream-completed', payload: {} }),
        makeEvent({ seq: 2, turnId: 'b', kind: 'stream-completed', payload: {} }),
      ];
      const { entries } = reconcileStreamEvents([], events, createReconcilerState());
      assert.equal(entries.length, 2);
      const a = entries.find((e) => e.turnId === 'a');
      const b = entries.find((e) => e.turnId === 'b');
      assert.ok(a);
      assert.ok(b);
      assert.equal(a.contentBlocks[0].text, 'A-text');
      assert.equal(b.contentBlocks[0].text, 'B-text');
      assert.equal(a.status, 'completed');
      assert.equal(b.status, 'completed');
    });
  });

  // ── idempotency / replay safety ───────────────────────────────────────

  describe('replay safety', () => {
    it('produces identical output when the same batch is applied twice', () => {
      const events: StreamEvent[] = [
        makeEvent({ seq: 0, turnId: 't1', kind: 'stream-started', payload: {} }),
        makeEvent({ seq: 1, turnId: 't1', kind: 'text-delta', payload: { text: 'data' } }),
        makeEvent({ seq: 2, turnId: 't1', kind: 'stream-completed', payload: {} }),
      ];
      const first = reconcileStreamEvents([], events, createReconcilerState());
      const second = reconcileStreamEvents(first.entries, events, first.state);
      assert.deepStrictEqual(second.entries, first.entries);
    });

    it('does not re-create entries on replayed stream-started', () => {
      const existing = makeEntry({
        entryId: 'turn-1',
        turnId: 'turn-1',
        status: 'completed',
        contentBlocks: [
          { blockId: 'turn-1-streaming', kind: 'text', text: 'done', metadata: null },
        ],
      });
      const state = stateWithHighWater([['turn-1', 10]]);
      const events = [makeEvent({ seq: 0, turnId: 'turn-1', kind: 'stream-started', payload: {} })];
      const { entries } = reconcileStreamEvents([existing], events, state);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].status, 'completed');
      assert.equal(entries[0].contentBlocks[0].text, 'done');
    });
  });

  // ── turn-entry isolation (activity-group must not hijack turn updates) ──

  describe('turn-entry isolation', () => {
    it('text-delta targets the turn entry, not a pre-existing activity-group', () => {
      const turnEntry = makeEntry({
        entryId: 'turn-1',
        turnId: 'turn-1',
        kind: 'turn',
        status: 'streaming',
        contentBlocks: [],
      });
      const activityEntry = makeEntry({
        entryId: 'turn-1-activity',
        turnId: 'turn-1',
        kind: 'activity-group',
        status: 'active',
        contentBlocks: [{ blockId: 'act-blk', kind: 'status', text: 'Analyzing…', metadata: null }],
      });
      const event = makeEvent({
        seq: 1,
        turnId: 'turn-1',
        kind: 'text-delta',
        payload: { text: 'Hello' },
      });
      const { entries } = reconcileStreamEvents(
        [turnEntry, activityEntry],
        [event],
        createReconcilerState(),
      );
      const turn = entries.find((e) => e.kind === 'turn');
      const activity = entries.find((e) => e.kind === 'activity-group');
      assert.ok(turn);
      assert.ok(activity);
      assert.equal(turn.contentBlocks.length, 1, 'turn entry should have the text delta');
      assert.equal(turn.contentBlocks[0].text, 'Hello');
      assert.equal(activity.contentBlocks.length, 1, 'activity-group should be unchanged');
      assert.equal(activity.contentBlocks[0].text, 'Analyzing…');
    });

    it('ensureTurnEntry creates a turn entry even when an activity-group already exists', () => {
      const activityEntry = makeEntry({
        entryId: 'turn-1-activity',
        turnId: 'turn-1',
        kind: 'activity-group',
        status: 'active',
        contentBlocks: [],
      });
      const event = makeEvent({
        seq: 1,
        turnId: 'turn-1',
        kind: 'text-delta',
        payload: { text: 'data' },
      });
      const { entries } = reconcileStreamEvents([activityEntry], [event], createReconcilerState());
      const turns = entries.filter((e) => e.kind === 'turn');
      const activities = entries.filter((e) => e.kind === 'activity-group');
      assert.equal(turns.length, 1, 'a new turn entry should be created');
      assert.equal(activities.length, 1, 'activity-group should remain');
      assert.equal(turns[0].contentBlocks[0].text, 'data');
    });

    it('approval-prompt attaches to turn, not activity-group', () => {
      const turnEntry = makeEntry({
        entryId: 'turn-1',
        turnId: 'turn-1',
        kind: 'turn',
        status: 'streaming',
      });
      const activityEntry = makeEntry({
        entryId: 'turn-1-activity',
        turnId: 'turn-1',
        kind: 'activity-group',
        status: 'active',
        contentBlocks: [],
      });
      const event = makeEvent({
        seq: 3,
        turnId: 'turn-1',
        kind: 'approval-prompt',
        payload: {
          approvalId: 'p-1',
          allowedResponses: ['yes'],
          context: 'Confirm?',
        },
      });
      const { entries } = reconcileStreamEvents(
        [activityEntry, turnEntry],
        [event],
        createReconcilerState(),
      );
      const turn = entries.find((e) => e.kind === 'turn');
      const activity = entries.find((e) => e.kind === 'activity-group');
      assert.ok(turn?.prompt, 'turn entry should have the prompt');
      assert.equal(turn?.prompt?.promptId, 'p-1');
      assert.equal(activity?.prompt, null, 'activity-group should have no prompt');
    });

    it('status-change updates only the turn entry, not the activity-group', () => {
      const turnEntry = makeEntry({
        entryId: 'turn-1',
        turnId: 'turn-1',
        kind: 'turn',
        status: 'streaming',
      });
      const activityEntry = makeEntry({
        entryId: 'turn-1-activity',
        turnId: 'turn-1',
        kind: 'activity-group',
        status: 'active',
        contentBlocks: [],
      });
      const event = makeEvent({
        seq: 2,
        turnId: 'turn-1',
        kind: 'status-change',
        payload: { status: 'awaiting-approval' },
      });
      const { entries } = reconcileStreamEvents(
        [turnEntry, activityEntry],
        [event],
        createReconcilerState(),
      );
      const turn = entries.find((e) => e.kind === 'turn');
      const activity = entries.find((e) => e.kind === 'activity-group');
      assert.equal(turn?.status, 'awaiting-approval');
      assert.equal(activity?.status, 'active', 'activity-group status unchanged');
    });
  });

  // ── immutability ──────────────────────────────────────────────────────

  describe('immutability', () => {
    it('does not mutate the input entries array', () => {
      const entries: TranscriptEntryState[] = [];
      const event = makeEvent({ seq: 0, turnId: 't1', kind: 'stream-started', payload: {} });
      reconcileStreamEvents(entries, [event], createReconcilerState());
      assert.equal(entries.length, 0);
    });

    it('does not mutate entry objects in place', () => {
      const entry = makeEntry({
        entryId: 'turn-1',
        turnId: 'turn-1',
        status: 'streaming',
        contentBlocks: [],
      });
      const event = makeEvent({
        seq: 1,
        turnId: 'turn-1',
        kind: 'text-delta',
        payload: { text: 'added' },
      });
      reconcileStreamEvents([entry], [event], createReconcilerState());
      assert.equal(entry.contentBlocks.length, 0);
      assert.equal(entry.status, 'streaming');
    });
  });
});
