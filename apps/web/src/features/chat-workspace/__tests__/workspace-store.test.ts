import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createInitialWorkspaceState,
  createWorkspaceStore,
  reduceWorkspaceState,
  type TranscriptEntryState,
  type WorkspaceConversationRecord,
} from '../model/workspace-store.ts';

function createConversation(
  overrides: Partial<WorkspaceConversationRecord> = {},
): WorkspaceConversationRecord {
  return {
    id: 'conv-1',
    title: 'Primary conversation',
    ...overrides,
  };
}

function createEntry(overrides: Partial<TranscriptEntryState> = {}): TranscriptEntryState {
  return {
    entryId: 'entry-1',
    kind: 'turn',
    turnId: 'turn-1',
    status: 'completed',
    timestamp: '2026-03-20T00:00:00.000Z',
    contentBlocks: [],
    artifacts: [],
    controls: [],
    prompt: null,
    ...overrides,
  };
}

describe('createInitialWorkspaceState', () => {
  it('builds the empty workspace baseline', () => {
    const state = createInitialWorkspaceState();

    assert.equal(state.activeConversationId, null);
    assert.deepStrictEqual(state.conversationOrder, []);
    assert.equal(state.conversations.size, 0);
    assert.equal(state.drafts.size, 0);
    assert.equal(state.visibleArtifact, null);
    assert.equal(state.connection.transportStatus, 'connecting');
    assert.equal(state.connection.sessionStatus, 'active');
  });
});

describe('reduceWorkspaceState', () => {
  it('upserts conversations without duplicating order entries', () => {
    const initial = createInitialWorkspaceState();
    const first = reduceWorkspaceState(initial, {
      type: 'conversation/upsert',
      conversation: createConversation(),
    });
    const second = reduceWorkspaceState(first, {
      type: 'conversation/upsert',
      conversation: createConversation({ title: 'Renamed conversation' }),
    });

    assert.deepStrictEqual(second.conversationOrder, ['conv-1']);
    assert.equal(second.conversations.get('conv-1')?.title, 'Renamed conversation');
  });

  it('captures lineage for branch conversations', () => {
    const state = reduceWorkspaceState(createInitialWorkspaceState(), {
      type: 'conversation/upsert',
      conversation: createConversation({
        id: 'conv-branch',
        parentConversationId: 'conv-root',
        forkPointTurnId: 'turn-root',
      }),
    });

    assert.deepStrictEqual(state.conversations.get('conv-branch')?.lineageSummary, {
      sourceConversationId: 'conv-root',
      sourceTurnId: 'turn-root',
      relationshipKind: 'branch',
    });
  });

  it('selects a conversation and seeds a conversation-owned draft', () => {
    const state = reduceWorkspaceState(createInitialWorkspaceState(), {
      type: 'conversation/select',
      conversationId: 'conv-2',
    });

    assert.equal(state.activeConversationId, 'conv-2');
    assert.deepStrictEqual(state.conversationOrder, ['conv-2']);
    assert.equal(state.drafts.get('conv-2')?.conversationId, 'conv-2');
    assert.equal(state.drafts.get('conv-2')?.draftText, '');
  });

  it('replace-all seeds a draft for an auto-selected active conversation', () => {
    const state = reduceWorkspaceState(createInitialWorkspaceState(), {
      type: 'conversation/replace-all',
      conversations: [
        createConversation(),
        createConversation({ id: 'conv-2', title: 'Second conversation' }),
      ],
    });

    assert.equal(state.activeConversationId, 'conv-1');
    assert.equal(state.drafts.get('conv-1')?.conversationId, 'conv-1');
    assert.equal(state.drafts.get('conv-1')?.submitState, 'idle');
  });

  it('preserves draft ownership across multiple conversations', () => {
    let state = createInitialWorkspaceState();
    state = reduceWorkspaceState(state, { type: 'conversation/select', conversationId: 'conv-1' });
    state = reduceWorkspaceState(state, {
      type: 'draft/set-text',
      conversationId: 'conv-1',
      draftText: 'First draft',
    });
    state = reduceWorkspaceState(state, { type: 'conversation/select', conversationId: 'conv-2' });
    state = reduceWorkspaceState(state, {
      type: 'draft/set-text',
      conversationId: 'conv-2',
      draftText: 'Second draft',
    });

    assert.equal(state.drafts.get('conv-1')?.draftText, 'First draft');
    assert.equal(state.drafts.get('conv-2')?.draftText, 'Second draft');
  });

  it('clears a submission error after the operator corrects the draft text', () => {
    let state = createInitialWorkspaceState();
    state = reduceWorkspaceState(state, { type: 'conversation/select', conversationId: 'conv-1' });
    state = reduceWorkspaceState(state, {
      type: 'draft/set-submit-state',
      conversationId: 'conv-1',
      submitState: 'error',
      validationMessage: 'Too long',
    });
    state = reduceWorkspaceState(state, {
      type: 'draft/set-text',
      conversationId: 'conv-1',
      draftText: 'Fixed draft',
    });

    assert.equal(state.drafts.get('conv-1')?.draftText, 'Fixed draft');
    assert.equal(state.drafts.get('conv-1')?.submitState, 'idle');
    assert.equal(state.drafts.get('conv-1')?.validationMessage, null);
  });

  it('replaces entries and marks the conversation ready', () => {
    let state = createInitialWorkspaceState();
    state = reduceWorkspaceState(state, {
      type: 'conversation/upsert',
      conversation: createConversation(),
    });
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [createEntry()],
      hasMoreHistory: true,
    });

    assert.equal(state.conversations.get('conv-1')?.entries.length, 1);
    assert.equal(state.conversations.get('conv-1')?.loadState, 'ready');
    assert.equal(state.conversations.get('conv-1')?.hasMoreHistory, true);
  });
});

describe('createWorkspaceStore', () => {
  it('notifies subscribers with the latest state and action', () => {
    const store = createWorkspaceStore();
    const notifications: string[] = [];

    const unsubscribe = store.subscribe((state, action) => {
      notifications.push(`${action.type}:${state.activeConversationId ?? 'none'}`);
    });

    store.dispatch({ type: 'conversation/select', conversationId: 'conv-3' });
    unsubscribe();
    store.dispatch({ type: 'conversation/select', conversationId: 'conv-4' });

    assert.deepStrictEqual(notifications, ['conversation/select:conv-3']);
    assert.equal(store.getState().activeConversationId, 'conv-4');
  });
});
