import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { StreamEvent } from '@hydra/web-contracts';

import type { ContentBlockState, TranscriptEntryState } from '../model/workspace-types.ts';
import {
  createReconcilerState,
  isStaleEvent,
  reconcileStreamEvents,
  findEntryByTurnId,
  appendTextDelta,
  sealAuthoritativeTurns,
  mergeAuthoritativeEntries,
  deduplicateEntries,
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

    it('falls back to payload.error when reason is absent', () => {
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
        payload: { error: 'Legacy error path' },
      });
      const { entries } = reconcileStreamEvents([existing], [event], createReconcilerState());
      const errorBlock = entries[0].contentBlocks.find((b) => b.kind === 'status');
      assert.ok(errorBlock);
      assert.equal(errorBlock.text, 'Legacy error path');
    });

    it('falls back to payload.message when both reason and error are absent', () => {
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
        payload: { message: 'Something went wrong' },
      });
      const { entries } = reconcileStreamEvents([existing], [event], createReconcilerState());
      const errorBlock = entries[0].contentBlocks.find((b) => b.kind === 'status');
      assert.ok(errorBlock);
      assert.equal(errorBlock.text, 'Something went wrong');
    });

    it('prefers reason over error and message', () => {
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
        payload: { reason: 'primary', error: 'secondary', message: 'tertiary' },
      });
      const { entries } = reconcileStreamEvents([existing], [event], createReconcilerState());
      const errorBlock = entries[0].contentBlocks.find((b) => b.kind === 'status');
      assert.ok(errorBlock);
      assert.equal(errorBlock.text, 'primary');
    });

    it('does not append error block when no reason/error/message is present', () => {
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
        payload: {},
      });
      const { entries } = reconcileStreamEvents([existing], [event], createReconcilerState());
      assert.equal(entries[0].status, 'failed');
      assert.equal(entries[0].contentBlocks.length, 0);
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
        },
      });
      const { entries } = reconcileStreamEvents([existing], [event], createReconcilerState());
      assert.ok(entries[0].prompt);
      assert.equal(entries[0].prompt?.promptId, 'prompt-1');
      assert.equal(entries[0].prompt?.status, 'pending');
    });

    it('does not attach a prompt when approvalId is missing', () => {
      const existing = makeEntry({
        entryId: 'turn-1',
        turnId: 'turn-1',
        status: 'streaming',
      });
      const event = makeEvent({
        seq: 3,
        turnId: 'turn-1',
        kind: 'approval-prompt',
        payload: {},
      });
      const { entries } = reconcileStreamEvents([existing], [event], createReconcilerState());
      assert.equal(entries[0].prompt, null, 'prompt must remain null for missing approvalId');
    });

    it('does not create a ghost turn when approvalId is missing on an empty transcript', () => {
      const event = makeEvent({
        seq: 3,
        turnId: 'turn-1',
        kind: 'approval-prompt',
        payload: {},
      });
      const result = reconcileStreamEvents([], [event], createReconcilerState());
      assert.equal(result.entries.length, 0);
      assert.ok(result.consumedSeqs.has(3));
      assert.equal(result.state.highWaterSeq.get('turn-1'), 3);
    });

    it('does not attach a prompt when approvalId is empty string', () => {
      const existing = makeEntry({
        entryId: 'turn-1',
        turnId: 'turn-1',
        status: 'streaming',
      });
      const event = makeEvent({
        seq: 3,
        turnId: 'turn-1',
        kind: 'approval-prompt',
        payload: { approvalId: '' },
      });
      const { entries } = reconcileStreamEvents([existing], [event], createReconcilerState());
      assert.equal(entries[0].prompt, null, 'prompt must remain null for empty approvalId');
    });

    it('does not attach a prompt when approvalId is non-string', () => {
      const existing = makeEntry({
        entryId: 'turn-1',
        turnId: 'turn-1',
        status: 'streaming',
      });
      const event = makeEvent({
        seq: 3,
        turnId: 'turn-1',
        kind: 'approval-prompt',
        payload: { approvalId: 42 },
      });
      const { entries } = reconcileStreamEvents([existing], [event], createReconcilerState());
      assert.equal(entries[0].prompt, null, 'prompt must remain null for non-string approvalId');
    });

    it('preserves existing prompt when new approval-prompt has invalid approvalId', () => {
      const existingPrompt = {
        promptId: 'old-prompt',
        parentTurnId: 'turn-1',
        status: 'pending' as const,
        allowedResponses: [] as readonly string[],
        contextBlocks: [] as readonly ContentBlockState[],
        lastResponseSummary: null,
        errorMessage: null,
        staleReason: null,
      };
      const existing = makeEntry({
        entryId: 'turn-1',
        turnId: 'turn-1',
        status: 'streaming',
        prompt: existingPrompt,
      });
      const event = makeEvent({
        seq: 3,
        turnId: 'turn-1',
        kind: 'approval-prompt',
        payload: { approvalId: '' },
      });
      const { entries } = reconcileStreamEvents([existing], [event], createReconcilerState());
      assert.deepStrictEqual(
        entries[0].prompt,
        existingPrompt,
        'existing prompt must be preserved',
      );
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
          allowedResponses: [],
          contextBlocks: [],
          lastResponseSummary: null,
          errorMessage: null,
          staleReason: null,
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

    it('stores operator-facing label in lastResponseSummary when allowedResponses has labels', () => {
      const existing = makeEntry({
        entryId: 'turn-1',
        turnId: 'turn-1',
        status: 'streaming',
        prompt: {
          promptId: 'prompt-1',
          parentTurnId: 'turn-1',
          status: 'pending',
          allowedResponses: [
            { key: 'approve_with_changes', label: 'Approve with changes' },
            { key: 'deny', label: 'Deny' },
          ],
          contextBlocks: [],
          lastResponseSummary: null,
          errorMessage: null,
          staleReason: null,
        },
      });
      const event = makeEvent({
        seq: 4,
        turnId: 'turn-1',
        kind: 'approval-response',
        payload: { approvalId: 'prompt-1', response: 'approve_with_changes' },
      });
      const { entries } = reconcileStreamEvents([existing], [event], createReconcilerState());
      assert.equal(entries[0].prompt?.status, 'resolved');
      assert.equal(
        entries[0].prompt?.lastResponseSummary,
        'Approve with changes',
        'must store operator-facing label, not raw key',
      );
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
          allowedResponses: [],
          contextBlocks: [],
          lastResponseSummary: null,
          errorMessage: null,
          staleReason: null,
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
          allowedResponses: [],
          contextBlocks: [],
          lastResponseSummary: null,
          errorMessage: null,
          staleReason: null,
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

    it('does not advance highWaterSeq for ignored approval-response (missing prompt)', () => {
      const existing = makeEntry({
        entryId: 'turn-1',
        turnId: 'turn-1',
        status: 'streaming',
        prompt: null,
      });
      const response = makeEvent({
        seq: 5,
        turnId: 'turn-1',
        kind: 'approval-response',
        payload: { approvalId: 'prompt-1', response: 'approve' },
      });
      const { state } = reconcileStreamEvents([existing], [response], createReconcilerState());
      assert.equal(
        state.highWaterSeq.has('turn-1'),
        false,
        'no-op approval-response must not consume seq',
      );
    });

    it('does not advance highWaterSeq for mismatched approvalId', () => {
      const existing = makeEntry({
        entryId: 'turn-1',
        turnId: 'turn-1',
        status: 'streaming',
        prompt: {
          promptId: 'prompt-2',
          parentTurnId: 'turn-1',
          status: 'pending',
          allowedResponses: [],
          contextBlocks: [],
          lastResponseSummary: null,
          errorMessage: null,
          staleReason: null,
        },
      });
      const response = makeEvent({
        seq: 5,
        turnId: 'turn-1',
        kind: 'approval-response',
        payload: { approvalId: 'prompt-1', response: 'approve' },
      });
      const { state } = reconcileStreamEvents([existing], [response], createReconcilerState());
      assert.equal(
        state.highWaterSeq.has('turn-1'),
        false,
        'mismatched approval-response must not consume seq',
      );
    });

    it('replays ignored approval-response after prerequisite prompt arrives', () => {
      // Phase 1: approval-response arrives before its prompt — should be a no-op
      const existing = makeEntry({
        entryId: 'turn-1',
        turnId: 'turn-1',
        status: 'streaming',
        prompt: null,
      });
      const earlyResponse = makeEvent({
        seq: 5,
        turnId: 'turn-1',
        kind: 'approval-response',
        payload: { approvalId: 'prompt-1', response: 'approve' },
      });
      const r1 = reconcileStreamEvents([existing], [earlyResponse], createReconcilerState());
      assert.equal(r1.entries[0].prompt, null, 'early response must be ignored');

      // Phase 2: the prompt event arrives, establishing the prompt
      const prompt = makeEvent({
        seq: 3,
        turnId: 'turn-1',
        kind: 'approval-prompt',
        payload: {
          approvalId: 'prompt-1',
        },
      });
      const r2 = reconcileStreamEvents(r1.entries, [prompt], r1.state);
      assert.equal(r2.entries[0].prompt?.status, 'pending');

      // Phase 3: replay the same approval-response — must not be stale
      const r3 = reconcileStreamEvents(r2.entries, [earlyResponse], r2.state);
      assert.equal(
        r3.entries[0].prompt?.status,
        'resolved',
        'replayed approval-response must resolve the prompt',
      );
      assert.equal(r3.entries[0].prompt?.lastResponseSummary, 'approve');
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

  // ── consumedSeqs tracking ─────────────────────────────────────────────

  describe('consumedSeqs', () => {
    it('includes seq of all mutating events', () => {
      const events: StreamEvent[] = [
        makeEvent({ seq: 1, turnId: 'turn-1', kind: 'stream-started', payload: {} }),
        makeEvent({ seq: 2, turnId: 'turn-1', kind: 'text-delta', payload: { text: 'hi' } }),
        makeEvent({
          seq: 3,
          turnId: 'turn-1',
          kind: 'stream-completed',
          payload: { status: 'completed' },
        }),
      ];
      const { consumedSeqs } = reconcileStreamEvents([], events, createReconcilerState());
      assert.deepStrictEqual([...consumedSeqs].sort(), [1, 2, 3]);
    });

    it('includes checkpoint seq even though entries are unchanged', () => {
      const entry = makeEntry({ entryId: 'turn-1', turnId: 'turn-1' });
      const events: StreamEvent[] = [
        makeEvent({ seq: 5, turnId: 'turn-1', kind: 'checkpoint', payload: {} }),
      ];
      const { consumedSeqs } = reconcileStreamEvents([entry], events, createReconcilerState());
      assert.ok(consumedSeqs.has(5), 'checkpoint must appear in consumedSeqs');
    });

    it('excludes stale events that were skipped', () => {
      const entry = makeEntry({ entryId: 'turn-1', turnId: 'turn-1', status: 'streaming' });
      const state = stateWithHighWater([['turn-1', 3]]);
      const events: StreamEvent[] = [
        makeEvent({ seq: 2, turnId: 'turn-1', kind: 'text-delta', payload: { text: 'old' } }),
        makeEvent({ seq: 4, turnId: 'turn-1', kind: 'text-delta', payload: { text: 'new' } }),
      ];
      const { consumedSeqs } = reconcileStreamEvents([entry], events, state);
      assert.ok(!consumedSeqs.has(2), 'stale event must not be in consumedSeqs');
      assert.ok(consumedSeqs.has(4), 'fresh event must be in consumedSeqs');
    });

    it('excludes ignored approval-response with missing prompt', () => {
      const entry = makeEntry({
        entryId: 'turn-1',
        turnId: 'turn-1',
        status: 'streaming',
        prompt: null,
      });
      const events: StreamEvent[] = [
        makeEvent({
          seq: 5,
          turnId: 'turn-1',
          kind: 'approval-response',
          payload: { approvalId: 'prompt-1', response: 'approve' },
        }),
      ];
      const { consumedSeqs } = reconcileStreamEvents([entry], events, createReconcilerState());
      assert.ok(!consumedSeqs.has(5), 'ignored approval-response must not be consumed');
    });

    it('excludes approval-response with mismatched approvalId', () => {
      const entry = makeEntry({
        entryId: 'turn-1',
        turnId: 'turn-1',
        status: 'streaming',
        prompt: {
          promptId: 'prompt-2',
          parentTurnId: 'turn-1',
          status: 'pending',
          allowedResponses: [],
          contextBlocks: [],
          lastResponseSummary: null,
          errorMessage: null,
          staleReason: null,
        },
      });
      const events: StreamEvent[] = [
        makeEvent({
          seq: 5,
          turnId: 'turn-1',
          kind: 'approval-response',
          payload: { approvalId: 'prompt-1', response: 'approve' },
        }),
      ];
      const { consumedSeqs } = reconcileStreamEvents([entry], events, createReconcilerState());
      assert.ok(!consumedSeqs.has(5), 'mismatched approval-response must not be consumed');
    });

    it('includes matching approval-response that resolves a prompt', () => {
      const entry = makeEntry({
        entryId: 'turn-1',
        turnId: 'turn-1',
        status: 'streaming',
        prompt: {
          promptId: 'prompt-1',
          parentTurnId: 'turn-1',
          status: 'pending',
          allowedResponses: [],
          contextBlocks: [],
          lastResponseSummary: null,
          errorMessage: null,
          staleReason: null,
        },
      });
      const events: StreamEvent[] = [
        makeEvent({
          seq: 5,
          turnId: 'turn-1',
          kind: 'approval-response',
          payload: { approvalId: 'prompt-1', response: 'approve' },
        }),
      ];
      const { consumedSeqs } = reconcileStreamEvents([entry], events, createReconcilerState());
      assert.ok(consumedSeqs.has(5), 'matching approval-response must be consumed');
    });
  });
});

// ─── sealAuthoritativeTurns ─────────────────────────────────────────────────

describe('sealAuthoritativeTurns', () => {
  it('seals turns with completed status', () => {
    const entries = [makeEntry({ turnId: 'turn-1', status: 'completed' })];
    const result = sealAuthoritativeTurns(createReconcilerState(), entries);
    assert.ok(result.sealedTurns?.has('turn-1'));
  });

  it('seals turns with failed status', () => {
    const entries = [makeEntry({ turnId: 'turn-1', status: 'failed' })];
    const result = sealAuthoritativeTurns(createReconcilerState(), entries);
    assert.ok(result.sealedTurns?.has('turn-1'));
  });

  it('seals turns with cancelled status', () => {
    const entries = [makeEntry({ turnId: 'turn-1', status: 'cancelled' })];
    const result = sealAuthoritativeTurns(createReconcilerState(), entries);
    assert.ok(result.sealedTurns?.has('turn-1'));
  });

  it('does not seal turns with streaming status', () => {
    const entries = [makeEntry({ turnId: 'turn-1', status: 'streaming' })];
    const result = sealAuthoritativeTurns(createReconcilerState(), entries);
    assert.equal(result.sealedTurns?.has('turn-1') ?? false, false);
  });

  it('does not seal turns with awaiting-approval status', () => {
    const entries = [makeEntry({ turnId: 'turn-1', status: 'awaiting-approval' })];
    const result = sealAuthoritativeTurns(createReconcilerState(), entries);
    assert.equal(result.sealedTurns?.has('turn-1') ?? false, false);
  });

  it('does not seal non-turn entries', () => {
    const entries = [
      makeEntry({ entryId: 'sys-1', kind: 'system-status', turnId: 'turn-1', status: 'completed' }),
    ];
    const result = sealAuthoritativeTurns(createReconcilerState(), entries);
    assert.equal(result.sealedTurns?.has('turn-1') ?? false, false);
  });

  it('preserves existing high-water marks', () => {
    const state = stateWithHighWater([['turn-1', 5]]);
    const entries = [makeEntry({ turnId: 'turn-2', status: 'completed' })];
    const result = sealAuthoritativeTurns(state, entries);
    assert.equal(result.highWaterSeq.get('turn-1'), 5);
    assert.ok(result.sealedTurns?.has('turn-2'));
  });

  it('preserves existing sealed turns', () => {
    const state: ReconcilerState = {
      highWaterSeq: new Map(),
      sealedTurns: new Set(['turn-old']),
    };
    const entries = [makeEntry({ turnId: 'turn-new', status: 'completed' })];
    const result = sealAuthoritativeTurns(state, entries);
    assert.ok(result.sealedTurns?.has('turn-old'));
    assert.ok(result.sealedTurns?.has('turn-new'));
  });

  it('skips entries with null turnId', () => {
    const entries = [makeEntry({ turnId: null, status: 'completed' })];
    const result = sealAuthoritativeTurns(createReconcilerState(), entries);
    assert.equal(result.sealedTurns?.size ?? 0, 0);
  });
});

// ─── isStaleEvent with sealed turns ─────────────────────────────────────────

describe('isStaleEvent with sealed turns', () => {
  it('returns true for events targeting a sealed turn', () => {
    const state: ReconcilerState = {
      highWaterSeq: new Map(),
      sealedTurns: new Set(['turn-1']),
    };
    const event = makeEvent({ seq: 100, turnId: 'turn-1' });
    assert.equal(isStaleEvent(event, state), true);
  });

  it('returns false for events targeting an unsealed turn', () => {
    const state: ReconcilerState = {
      highWaterSeq: new Map(),
      sealedTurns: new Set(['turn-other']),
    };
    const event = makeEvent({ seq: 1, turnId: 'turn-1' });
    assert.equal(isStaleEvent(event, state), false);
  });

  it('sealed turn check takes precedence over high-water', () => {
    const state: ReconcilerState = {
      highWaterSeq: new Map([['turn-1', 0]]),
      sealedTurns: new Set(['turn-1']),
    };
    // seq 100 is above high-water 0, but turn is sealed
    const event = makeEvent({ seq: 100, turnId: 'turn-1' });
    assert.equal(isStaleEvent(event, state), true);
  });

  it('works with empty sealedTurns (backward-compatible)', () => {
    const state = stateWithHighWater([['turn-1', 5]]);
    const event = makeEvent({ seq: 3, turnId: 'turn-1' });
    assert.equal(isStaleEvent(event, state), true);
  });
});

// ─── mergeAuthoritativeEntries ──────────────────────────────────────────────

describe('mergeAuthoritativeEntries', () => {
  it('returns REST entries when no current entries exist', () => {
    const rest = [
      makeEntry({ entryId: 'turn-a', turnId: 'turn-a', status: 'completed' }),
      makeEntry({ entryId: 'turn-b', turnId: 'turn-b', status: 'completed' }),
    ];
    const result = mergeAuthoritativeEntries(rest, []);
    assert.equal(result.length, 2);
    assert.equal(result[0].turnId, 'turn-a');
    assert.equal(result[1].turnId, 'turn-b');
  });

  it('returns current entries when REST is empty', () => {
    const current = [makeEntry({ entryId: 'turn-a', turnId: 'turn-a', status: 'streaming' })];
    const result = mergeAuthoritativeEntries([], current);
    assert.equal(result.length, 1);
    assert.equal(result[0].turnId, 'turn-a');
  });

  it('appends stream-only turn entries after REST entries', () => {
    const rest = [makeEntry({ entryId: 'turn-a', turnId: 'turn-a', status: 'completed' })];
    const current = [
      makeEntry({ entryId: 'turn-a', turnId: 'turn-a', status: 'completed' }),
      makeEntry({ entryId: 'turn-b', turnId: 'turn-b', status: 'streaming' }),
    ];
    const result = mergeAuthoritativeEntries(rest, current);
    assert.equal(result.length, 2);
    assert.equal(result[0].turnId, 'turn-a');
    assert.equal(result[1].turnId, 'turn-b');
    assert.equal(result[1].status, 'streaming');
  });

  it('preserves stream artifacts for completed turns in both REST and stream', () => {
    const rest = [
      makeEntry({ entryId: 'turn-a', turnId: 'turn-a', status: 'completed', artifacts: [] }),
    ];
    const current = [
      makeEntry({
        entryId: 'turn-a',
        turnId: 'turn-a',
        status: 'completed',
        artifacts: [{ artifactId: 'art-1', kind: 'file', label: 'f.ts', availability: 'listed' }],
      }),
    ];
    const result = mergeAuthoritativeEntries(rest, current);
    assert.equal(result[0].artifacts.length, 1);
    assert.equal(result[0].artifacts[0].artifactId, 'art-1');
  });

  it('preserves stream prompt for completed turns in both REST and stream', () => {
    const rest = [
      makeEntry({ entryId: 'turn-a', turnId: 'turn-a', status: 'completed', prompt: null }),
    ];
    const current = [
      makeEntry({
        entryId: 'turn-a',
        turnId: 'turn-a',
        status: 'completed',
        prompt: {
          promptId: 'p1',
          parentTurnId: 'turn-a',
          status: 'resolved',
          lastResponseSummary: 'ok',
        },
      }),
    ];
    const result = mergeAuthoritativeEntries(rest, current);
    assert.equal(result[0].prompt?.promptId, 'p1');
  });

  it('preserves stream controls for completed turns in both REST and stream', () => {
    const rest = [
      makeEntry({ entryId: 'turn-a', turnId: 'turn-a', status: 'completed', controls: [] }),
    ];
    const current = [
      makeEntry({
        entryId: 'turn-a',
        turnId: 'turn-a',
        status: 'completed',
        controls: [
          { controlId: 'c1', kind: 'retry', enabled: true, reasonDisabled: null },
        ],
      }),
    ];
    const result = mergeAuthoritativeEntries(rest, current);
    assert.equal(result[0].controls.length, 1);
    assert.equal(result[0].controls[0].controlId, 'c1');
  });

  it('uses REST content and status for turns in both REST and stream', () => {
    const rest = [
      makeEntry({
        entryId: 'turn-a',
        turnId: 'turn-a',
        status: 'completed',
        contentBlocks: [
          { blockId: 'blk-1', kind: 'text', text: 'REST authoritative content', metadata: null },
        ],
      }),
    ];
    const current = [
      makeEntry({
        entryId: 'turn-a',
        turnId: 'turn-a',
        status: 'streaming',
        contentBlocks: [
          { blockId: 'blk-1', kind: 'text', text: 'stale stream partial', metadata: null },
        ],
      }),
    ];
    const result = mergeAuthoritativeEntries(rest, current);
    assert.equal(result[0].status, 'completed');
    assert.equal(result[0].contentBlocks[0].text, 'REST authoritative content');
  });

  it('appends non-turn stream-only entries (activity-group)', () => {
    const rest = [makeEntry({ entryId: 'turn-a', turnId: 'turn-a', status: 'completed' })];
    const current = [
      makeEntry({ entryId: 'turn-a', turnId: 'turn-a', status: 'completed' }),
      makeEntry({
        entryId: 'turn-a-activity',
        kind: 'activity-group',
        turnId: 'turn-a',
        status: 'active',
      }),
    ];
    const result = mergeAuthoritativeEntries(rest, current);
    assert.equal(result.length, 2);
    assert.equal(result[1].kind, 'activity-group');
  });

  it('does not duplicate entries present in both REST and stream', () => {
    const rest = [
      makeEntry({ entryId: 'turn-a', turnId: 'turn-a', status: 'completed' }),
      makeEntry({ entryId: 'turn-b', turnId: 'turn-b', status: 'completed' }),
    ];
    const current = [
      makeEntry({ entryId: 'turn-a', turnId: 'turn-a', status: 'completed' }),
      makeEntry({ entryId: 'turn-b', turnId: 'turn-b', status: 'completed' }),
    ];
    const result = mergeAuthoritativeEntries(rest, current);
    assert.equal(result.length, 2);
  });

  it('does not duplicate non-turn entries with matching entryId in REST', () => {
    const sysEntry = makeEntry({
      entryId: 'turn-a-warning-1',
      kind: 'system-status',
      turnId: 'turn-a',
      status: 'warning',
    });
    const rest = [
      makeEntry({ entryId: 'turn-a', turnId: 'turn-a', status: 'completed' }),
      sysEntry,
    ];
    const current = [
      makeEntry({ entryId: 'turn-a', turnId: 'turn-a', status: 'completed' }),
      sysEntry,
    ];
    const result = mergeAuthoritativeEntries(rest, current);
    const sysEntries = result.filter((e) => e.kind === 'system-status');
    assert.equal(sysEntries.length, 1);
  });

  it('does not mutate input arrays', () => {
    const rest = [makeEntry({ entryId: 'turn-a', turnId: 'turn-a', status: 'completed' })];
    const current = [makeEntry({ entryId: 'turn-b', turnId: 'turn-b', status: 'streaming' })];
    const restCopy = [...rest];
    const currentCopy = [...current];
    mergeAuthoritativeEntries(rest, current);
    assert.deepStrictEqual(rest, restCopy);
    assert.deepStrictEqual(current, currentCopy);
  });
});

// ─── deduplicateEntries ─────────────────────────────────────────────────────

describe('deduplicateEntries', () => {
  it('returns entries unchanged when no duplicates', () => {
    const entries = [
      makeEntry({ entryId: 'e1', turnId: 'turn-1' }),
      makeEntry({ entryId: 'e2', turnId: 'turn-2' }),
    ];
    const result = deduplicateEntries(entries);
    assert.equal(result.length, 2);
    assert.equal(result[0].entryId, 'e1');
    assert.equal(result[1].entryId, 'e2');
  });

  it('removes duplicate turn entries by turnId keeping first occurrence', () => {
    const entries = [
      makeEntry({ entryId: 'e1', turnId: 'turn-1', status: 'completed' }),
      makeEntry({ entryId: 'e2', turnId: 'turn-1', status: 'streaming' }),
    ];
    const result = deduplicateEntries(entries);
    assert.equal(result.length, 1);
    assert.equal(result[0].entryId, 'e1');
    assert.equal(result[0].status, 'completed');
  });

  it('removes duplicate non-turn entries by entryId keeping first occurrence', () => {
    const entries = [
      makeEntry({ entryId: 'sys-1', kind: 'system-status', turnId: 'turn-1' }),
      makeEntry({ entryId: 'sys-1', kind: 'system-status', turnId: 'turn-1' }),
    ];
    const result = deduplicateEntries(entries);
    assert.equal(result.length, 1);
  });

  it('handles empty array', () => {
    assert.deepStrictEqual(deduplicateEntries([]), []);
  });

  it('preserves order of unique entries', () => {
    const entries = [
      makeEntry({ entryId: 'e3', turnId: 'turn-3' }),
      makeEntry({ entryId: 'e1', turnId: 'turn-1' }),
      makeEntry({ entryId: 'e2', turnId: 'turn-2' }),
    ];
    const result = deduplicateEntries(entries);
    assert.equal(result[0].entryId, 'e3');
    assert.equal(result[1].entryId, 'e1');
    assert.equal(result[2].entryId, 'e2');
  });

  it('handles mixed turn and non-turn entries with duplicates', () => {
    const entries = [
      makeEntry({ entryId: 'turn-a', turnId: 'turn-a', kind: 'turn' }),
      makeEntry({ entryId: 'act-1', turnId: 'turn-a', kind: 'activity-group' }),
      makeEntry({ entryId: 'turn-a-dup', turnId: 'turn-a', kind: 'turn' }),
    ];
    const result = deduplicateEntries(entries);
    assert.equal(result.length, 2);
    assert.equal(result[0].entryId, 'turn-a');
    assert.equal(result[1].entryId, 'act-1');
  });
});
