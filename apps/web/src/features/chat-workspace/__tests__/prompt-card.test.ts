/**
 * Tests for prompt card helpers, async respond flow, and prompt selectors.
 *
 * Uses node:test — pure logic only, no JSX rendering.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  filterPendingPrompts,
  getPromptStatusLabel,
  isPromptActionable,
  isPromptTerminal,
  respondToPrompt,
} from '../model/prompt-helpers.ts';
import { selectPendingPrompts } from '../model/selectors.ts';
import { createInitialWorkspaceState, reduceWorkspaceState } from '../model/workspace-reducer.ts';
import type {
  ConversationViewState,
  PromptViewState,
  TranscriptEntryState,
  WorkspaceAction,
  WorkspaceState,
  WorkspaceStore,
} from '../model/workspace-types.ts';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makePrompt(overrides: Partial<PromptViewState> = {}): PromptViewState {
  return {
    promptId: 'prompt-1',
    parentTurnId: 'turn-1',
    status: 'pending',
    allowedResponses: ['approve', 'deny'],
    contextBlocks: [],
    lastResponseSummary: null,
    errorMessage: null,
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

function stateWithPrompt(prompt: PromptViewState): WorkspaceState {
  const entry = makeEntry({
    entryId: 'turn-1',
    turnId: 'turn-1',
    status: 'streaming',
    prompt,
  });
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
    controlState: { canSubmit: true, submissionPolicyLabel: 'Ready', staleReason: null },
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

function createMockStore(initialState: WorkspaceState): WorkspaceStore & {
  dispatched: WorkspaceAction[];
} {
  let state = initialState;
  const dispatched: WorkspaceAction[] = [];
  const listeners = new Set<() => void>();

  return {
    dispatched,
    getState() {
      return state;
    },
    dispatch(action: WorkspaceAction) {
      dispatched.push(action);
      state = reduceWorkspaceState(state, action);
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// ─── getPromptStatusLabel ───────────────────────────────────────────────────

describe('getPromptStatusLabel', () => {
  it('returns pending label', () => {
    assert.equal(getPromptStatusLabel('pending'), '⏳ Approval pending');
  });

  it('returns responding label', () => {
    assert.equal(getPromptStatusLabel('responding'), '⏳ Submitting response…');
  });

  it('returns resolved label', () => {
    assert.equal(getPromptStatusLabel('resolved'), '✓ Approval resolved');
  });

  it('returns stale label', () => {
    assert.equal(getPromptStatusLabel('stale'), '⚠ Approval stale');
  });

  it('returns unavailable label', () => {
    assert.equal(getPromptStatusLabel('unavailable'), '✕ Approval unavailable');
  });

  it('returns error label', () => {
    assert.equal(getPromptStatusLabel('error'), '✕ Response failed');
  });
});

// ─── isPromptActionable ─────────────────────────────────────────────────────

describe('isPromptActionable', () => {
  it('returns true for pending', () => {
    assert.equal(isPromptActionable('pending'), true);
  });

  it('returns false for responding', () => {
    assert.equal(isPromptActionable('responding'), false);
  });

  it('returns false for resolved', () => {
    assert.equal(isPromptActionable('resolved'), false);
  });

  it('returns false for stale', () => {
    assert.equal(isPromptActionable('stale'), false);
  });

  it('returns false for unavailable', () => {
    assert.equal(isPromptActionable('unavailable'), false);
  });

  it('returns false for error', () => {
    assert.equal(isPromptActionable('error'), false);
  });
});

// ─── isPromptTerminal ───────────────────────────────────────────────────────

describe('isPromptTerminal', () => {
  it('returns true for resolved', () => {
    assert.equal(isPromptTerminal('resolved'), true);
  });

  it('returns true for stale', () => {
    assert.equal(isPromptTerminal('stale'), true);
  });

  it('returns true for unavailable', () => {
    assert.equal(isPromptTerminal('unavailable'), true);
  });

  it('returns false for pending', () => {
    assert.equal(isPromptTerminal('pending'), false);
  });

  it('returns false for responding', () => {
    assert.equal(isPromptTerminal('responding'), false);
  });

  it('returns false for error', () => {
    assert.equal(isPromptTerminal('error'), false);
  });
});

// ─── filterPendingPrompts ───────────────────────────────────────────────────

describe('filterPendingPrompts', () => {
  it('extracts pending prompts from entries', () => {
    const entries = [
      makeEntry({ prompt: makePrompt() }),
      makeEntry({ entryId: 'entry-2', prompt: makePrompt({ promptId: 'p2', status: 'resolved' }) }),
      makeEntry({ entryId: 'entry-3', prompt: null }),
    ];
    const pending = filterPendingPrompts(entries);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].promptId, 'prompt-1');
  });

  it('returns empty array when no pending prompts', () => {
    const entries = [
      makeEntry({ prompt: makePrompt({ status: 'resolved' }) }),
      makeEntry({ entryId: 'entry-2', prompt: null }),
    ];
    assert.deepStrictEqual(filterPendingPrompts(entries), []);
  });

  it('returns empty for empty entries', () => {
    assert.deepStrictEqual(filterPendingPrompts([]), []);
  });
});

// ─── selectPendingPrompts ───────────────────────────────────────────────────

describe('selectPendingPrompts', () => {
  it('returns pending prompts from the active conversation', () => {
    const state = stateWithPrompt(makePrompt());
    const pending = selectPendingPrompts(state);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].promptId, 'prompt-1');
  });

  it('returns empty when no prompts are pending', () => {
    const state = stateWithPrompt(makePrompt({ status: 'resolved' }));
    assert.deepStrictEqual(selectPendingPrompts(state), []);
  });

  it('returns empty when no active conversation', () => {
    const state = createInitialWorkspaceState();
    assert.deepStrictEqual(selectPendingPrompts(state), []);
  });
});

// ─── respondToPrompt ────────────────────────────────────────────────────────

describe('respondToPrompt', () => {
  it('dispatches begin-response, calls API, then confirms on success', async () => {
    const state = stateWithPrompt(makePrompt());
    const store = createMockStore(state);

    const mockClient = {
      async respondToApproval() {
        return {
          success: true,
          approval: { id: 'prompt-1', status: 'responded' as const },
        };
      },
    };

    const result = await respondToPrompt(
      { store, client: mockClient as Parameters<typeof respondToPrompt>[0]['client'] },
      { conversationId: 'conv-1', turnId: 'turn-1', promptId: 'prompt-1', response: 'approve' },
    );

    assert.equal(result.ok, true);
    assert.equal(store.dispatched.length, 2);
    assert.equal(store.dispatched[0].type, 'prompt/begin-response');
    assert.equal(store.dispatched[1].type, 'prompt/response-confirmed');

    const confirmed = store.dispatched[1];
    assert.equal(
      confirmed.type === 'prompt/response-confirmed' ? confirmed.responseSummary : null,
      'approve',
    );

    // Final state should be resolved
    const finalPrompt = store.getState().conversations.get('conv-1')?.entries[0].prompt;
    assert.equal(finalPrompt?.status, 'resolved');
    assert.equal(finalPrompt?.lastResponseSummary, 'approve');
  });

  it('dispatches begin-response then response-failed on API error', async () => {
    const state = stateWithPrompt(makePrompt());
    const store = createMockStore(state);

    const mockClient = {
      async respondToApproval() {
        throw new Error('Gateway 409: conflict');
      },
    };

    const result = await respondToPrompt(
      { store, client: mockClient as Parameters<typeof respondToPrompt>[0]['client'] },
      { conversationId: 'conv-1', turnId: 'turn-1', promptId: 'prompt-1', response: 'approve' },
    );

    assert.equal(result.ok, false);
    assert.equal(result.error, 'Gateway 409: conflict');
    assert.equal(store.dispatched.length, 2);
    assert.equal(store.dispatched[0].type, 'prompt/begin-response');
    assert.equal(store.dispatched[1].type, 'prompt/response-failed');

    const finalPrompt = store.getState().conversations.get('conv-1')?.entries[0].prompt;
    assert.equal(finalPrompt?.status, 'error');
    assert.equal(finalPrompt?.errorMessage, 'Gateway 409: conflict');
  });

  it('rejects when prompt is not pending', async () => {
    const state = stateWithPrompt(makePrompt({ status: 'resolved' }));
    const store = createMockStore(state);
    let apiCalled = false;
    const mockClient = {
      async respondToApproval() {
        apiCalled = true;
        return { success: true, approval: { id: 'prompt-1', status: 'responded' as const } };
      },
    };

    const result = await respondToPrompt(
      { store, client: mockClient as Parameters<typeof respondToPrompt>[0]['client'] },
      { conversationId: 'conv-1', turnId: 'turn-1', promptId: 'prompt-1', response: 'approve' },
    );

    assert.equal(result.ok, false);
    assert.equal(result.error, 'Prompt is not actionable');
    assert.equal(store.dispatched.length, 0);
    assert.equal(apiCalled, false);
  });

  it('rejects when prompt is already responding (prevents duplicates)', async () => {
    const state = stateWithPrompt(makePrompt({ status: 'responding' }));
    const store = createMockStore(state);
    let apiCalled = false;
    const mockClient = {
      async respondToApproval() {
        apiCalled = true;
        return { success: true, approval: { id: 'prompt-1', status: 'responded' as const } };
      },
    };

    const result = await respondToPrompt(
      { store, client: mockClient as Parameters<typeof respondToPrompt>[0]['client'] },
      { conversationId: 'conv-1', turnId: 'turn-1', promptId: 'prompt-1', response: 'approve' },
    );

    assert.equal(result.ok, false);
    assert.equal(apiCalled, false);
  });

  it('rejects when conversation does not exist', async () => {
    const state = createInitialWorkspaceState();
    const store = createMockStore(state);
    const mockClient = {
      async respondToApproval() {
        return { success: true, approval: { id: 'prompt-1', status: 'responded' as const } };
      },
    };

    const result = await respondToPrompt(
      { store, client: mockClient as Parameters<typeof respondToPrompt>[0]['client'] },
      {
        conversationId: 'nonexistent',
        turnId: 'turn-1',
        promptId: 'prompt-1',
        response: 'approve',
      },
    );

    assert.equal(result.ok, false);
    assert.equal(store.dispatched.length, 0);
  });
});
