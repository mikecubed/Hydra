import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { StreamEvent } from '@hydra/web-contracts';

import { createReconcilerState, reconcileStreamEvents } from '../model/reconciler.ts';
import { createInitialWorkspaceState, reduceWorkspaceState } from '../model/workspace-reducer.ts';
import type {
  ConversationViewState,
  PromptViewState,
  TranscriptEntryState,
  WorkspaceState,
} from '../model/workspace-types.ts';

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

function makePrompt(overrides: Partial<PromptViewState> = {}): PromptViewState {
  return {
    promptId: 'prompt-1',
    parentTurnId: 'turn-1',
    status: 'pending',
    allowedResponses: [],
    contextBlocks: [],
    lastResponseSummary: null,
    errorMessage: null,
    ...overrides,
  };
}

function stateWithPrompt(prompt: PromptViewState): WorkspaceState {
  const entry = makeEntry({ entryId: 'turn-1', turnId: 'turn-1', status: 'streaming', prompt });
  const conversation: ConversationViewState = {
    conversationId: 'conv-1',
    title: 'Test',
    status: 'active',
    createdAt: null,
    updatedAt: null,
    turnCount: 1,
    pendingInstructionCount: 0,
    lineageSummary: null,
    entries: [entry],
    hasMoreHistory: false,
    loadState: 'ready',
    historyLoaded: true,
    controlState: {
      canSubmit: true,
      submissionPolicyLabel: 'Ready',
      staleReason: null,
    },
  };
  const base = createInitialWorkspaceState();
  const conversations = new Map(base.conversations);
  conversations.set('conv-1', conversation);
  return {
    ...base,
    activeConversationId: 'conv-1',
    conversationOrder: ['conv-1'],
    conversations,
  };
}

describe('prompt lifecycle reconciler', () => {
  it('captures approval prompt metadata from stream payloads', () => {
    const { entries } = reconcileStreamEvents(
      [makeEntry({ turnId: 'turn-1', status: 'streaming' })],
      [
        makeEvent({
          seq: 1,
          turnId: 'turn-1',
          kind: 'approval-prompt',
          payload: {
            approvalId: 'p1',
            allowedResponses: ['approve', 42, 'deny'],
            contextBlocks: [
              { blockId: 'ctx-1', kind: 'text', text: 'Approve this change?', metadata: null },
            ],
          },
        }),
      ],
      createReconcilerState(),
    );

    assert.deepStrictEqual(entries[0].prompt, {
      promptId: 'p1',
      parentTurnId: 'turn-1',
      status: 'pending',
      allowedResponses: ['approve', 'deny'],
      contextBlocks: [
        { blockId: 'ctx-1', kind: 'text', text: 'Approve this change?', metadata: null },
      ],
      lastResponseSummary: null,
      errorMessage: null,
    });
  });

  it('marks pending prompts stale when the turn reaches a terminal state', () => {
    const pending = makeEntry({ prompt: makePrompt(), status: 'streaming' });

    const completed = reconcileStreamEvents(
      [pending],
      [makeEvent({ seq: 2, turnId: 'turn-1', kind: 'stream-completed', payload: {} })],
      createReconcilerState(),
    );
    assert.equal(completed.entries[0].prompt?.status, 'stale');

    const cancelled = reconcileStreamEvents(
      [makeEntry({ prompt: makePrompt({ status: 'responding' }), status: 'streaming' })],
      [makeEvent({ seq: 3, turnId: 'turn-1', kind: 'cancellation', payload: {} })],
      createReconcilerState(),
    );
    assert.equal(cancelled.entries[0].prompt?.status, 'stale');
  });

  it('keeps resolved prompts resolved on later terminal events', () => {
    const { entries } = reconcileStreamEvents(
      [makeEntry({ prompt: makePrompt({ status: 'resolved', lastResponseSummary: 'approve' }) })],
      [makeEvent({ seq: 4, turnId: 'turn-1', kind: 'stream-failed', payload: { reason: 'boom' } })],
      createReconcilerState(),
    );
    assert.equal(entries[0].prompt?.status, 'resolved');
    assert.equal(entries[0].prompt?.lastResponseSummary, 'approve');
  });
});

describe('prompt lifecycle reducer', () => {
  it('transitions prompts through responding, error, resolved, stale, unavailable, and hydrate states', () => {
    const initial = stateWithPrompt(makePrompt());

    const responding = reduceWorkspaceState(initial, {
      type: 'prompt/begin-response',
      conversationId: 'conv-1',
      turnId: 'turn-1',
      promptId: 'prompt-1',
    });
    assert.equal(responding.conversations.get('conv-1')?.entries[0].prompt?.status, 'responding');

    const errored = reduceWorkspaceState(responding, {
      type: 'prompt/response-failed',
      conversationId: 'conv-1',
      turnId: 'turn-1',
      promptId: 'prompt-1',
      errorMessage: 'Gateway 409',
    });
    assert.equal(errored.conversations.get('conv-1')?.entries[0].prompt?.status, 'error');
    assert.equal(
      errored.conversations.get('conv-1')?.entries[0].prompt?.errorMessage,
      'Gateway 409',
    );

    const hydrated = reduceWorkspaceState(initial, {
      type: 'prompt/hydrate',
      conversationId: 'conv-1',
      turnId: 'turn-1',
      promptId: 'prompt-1',
      allowedResponses: ['approve', 'deny'],
      contextBlocks: [{ blockId: 'ctx-1', kind: 'text', text: 'Need approval', metadata: null }],
    });
    assert.deepStrictEqual(
      hydrated.conversations.get('conv-1')?.entries[0].prompt?.allowedResponses,
      ['approve', 'deny'],
    );
    assert.equal(hydrated.conversations.get('conv-1')?.entries[0].prompt?.contextBlocks.length, 1);

    const resolved = reduceWorkspaceState(responding, {
      type: 'prompt/response-confirmed',
      conversationId: 'conv-1',
      turnId: 'turn-1',
      promptId: 'prompt-1',
      responseSummary: 'approve',
    });
    assert.equal(resolved.conversations.get('conv-1')?.entries[0].prompt?.status, 'resolved');
    assert.equal(
      resolved.conversations.get('conv-1')?.entries[0].prompt?.lastResponseSummary,
      'approve',
    );

    const stale = reduceWorkspaceState(initial, {
      type: 'prompt/mark-stale',
      conversationId: 'conv-1',
      turnId: 'turn-1',
      promptId: 'prompt-1',
      reason: 'Already answered',
    });
    assert.equal(stale.conversations.get('conv-1')?.entries[0].prompt?.status, 'stale');

    const unavailable = reduceWorkspaceState(initial, {
      type: 'prompt/mark-unavailable',
      conversationId: 'conv-1',
      turnId: 'turn-1',
      promptId: 'prompt-1',
    });
    assert.equal(unavailable.conversations.get('conv-1')?.entries[0].prompt?.status, 'unavailable');
  });

  it('does not regress a resolved prompt back to stale', () => {
    const resolvedState = stateWithPrompt(
      makePrompt({ status: 'resolved', lastResponseSummary: 'approve' }),
    );
    const next = reduceWorkspaceState(resolvedState, {
      type: 'prompt/mark-stale',
      conversationId: 'conv-1',
      turnId: 'turn-1',
      promptId: 'prompt-1',
      reason: 'late event',
    });
    assert.equal(next.conversations.get('conv-1')?.entries[0].prompt?.status, 'resolved');
    assert.equal(
      next.conversations.get('conv-1')?.entries[0].prompt?.lastResponseSummary,
      'approve',
    );
  });
});
