import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createInitialWorkspaceState,
  createWorkspaceStore,
  reduceWorkspaceState,
  type ArtifactViewState,
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
    attributionLabel: null,
    status: 'completed',
    timestamp: '2026-03-20T00:00:00.000Z',
    contentBlocks: [],
    artifacts: [],
    controls: [],
    prompt: null,
    ...overrides,
  };
}

function createArtifact(overrides: Partial<ArtifactViewState> = {}): ArtifactViewState {
  return {
    artifactId: 'art-1',
    turnId: 'turn-1',
    kind: 'code',
    label: 'Generated file',
    availability: 'ready',
    previewBlocks: [],
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

  it('replace-all prunes drafts for conversations removed by authoritative refresh', () => {
    let state = createInitialWorkspaceState();
    state = reduceWorkspaceState(state, { type: 'conversation/select', conversationId: 'conv-1' });
    state = reduceWorkspaceState(state, {
      type: 'draft/set-text',
      conversationId: 'conv-1',
      draftText: 'Stale draft',
    });
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-all',
      conversations: [],
    });

    assert.equal(state.activeConversationId, null);
    assert.deepStrictEqual(state.conversationOrder, []);
    assert.equal(state.conversations.size, 0);
    assert.equal(state.drafts.size, 0);
  });

  it('replace-all clears the visible artifact when the active conversation disappears', () => {
    let state = createInitialWorkspaceState();
    state = reduceWorkspaceState(state, { type: 'conversation/select', conversationId: 'conv-1' });
    state = reduceWorkspaceState(state, {
      type: 'artifact/show',
      artifact: createArtifact(),
    });
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-all',
      conversations: [],
    });

    assert.equal(state.activeConversationId, null);
    assert.equal(state.visibleArtifact, null);
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

  it('clears a submission error when the operator blanks the draft', () => {
    let state = createInitialWorkspaceState();
    state = reduceWorkspaceState(state, { type: 'conversation/select', conversationId: 'conv-1' });
    state = reduceWorkspaceState(state, {
      type: 'draft/set-text',
      conversationId: 'conv-1',
      draftText: 'Need to retry',
    });
    state = reduceWorkspaceState(state, {
      type: 'draft/set-submit-state',
      conversationId: 'conv-1',
      submitState: 'error',
      validationMessage: 'Too long',
    });
    state = reduceWorkspaceState(state, {
      type: 'draft/set-text',
      conversationId: 'conv-1',
      draftText: '',
    });

    assert.equal(state.drafts.get('conv-1')?.draftText, '');
    assert.equal(state.drafts.get('conv-1')?.submitState, 'idle');
    assert.equal(state.drafts.get('conv-1')?.validationMessage, null);
  });

  it('clears a submission error when a blank draft is reasserted', () => {
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
      draftText: '',
    });

    assert.equal(state.drafts.get('conv-1')?.draftText, '');
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

  it('adds unknown conversations to ordered state when load-state arrives first', () => {
    const state = reduceWorkspaceState(createInitialWorkspaceState(), {
      type: 'conversation/set-load-state',
      conversationId: 'conv-1',
      loadState: 'loading',
    });

    assert.deepStrictEqual(state.conversationOrder, ['conv-1']);
    assert.equal(state.conversations.get('conv-1')?.loadState, 'loading');
  });

  it('adds unknown conversations to ordered state when entries arrive first', () => {
    const state = reduceWorkspaceState(createInitialWorkspaceState(), {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [createEntry()],
      hasMoreHistory: false,
    });

    assert.deepStrictEqual(state.conversationOrder, ['conv-1']);
    assert.equal(state.conversations.get('conv-1')?.entries.length, 1);
    assert.equal(state.conversations.get('conv-1')?.loadState, 'ready');
  });

  it('merges a partial connection patch without clobbering other fields', () => {
    const state = reduceWorkspaceState(createInitialWorkspaceState(), {
      type: 'connection/merge',
      patch: { transportStatus: 'live', syncStatus: 'syncing' },
    });

    assert.equal(state.connection.transportStatus, 'live');
    assert.equal(state.connection.syncStatus, 'syncing');
    assert.equal(state.connection.sessionStatus, 'active');
    assert.equal(state.connection.daemonStatus, 'healthy');
  });

  it('applies successive connection patches additively', () => {
    let state = createInitialWorkspaceState();
    state = reduceWorkspaceState(state, {
      type: 'connection/merge',
      patch: { transportStatus: 'live' },
    });
    state = reduceWorkspaceState(state, {
      type: 'connection/merge',
      patch: { daemonStatus: 'unavailable' },
    });

    assert.equal(state.connection.transportStatus, 'live');
    assert.equal(state.connection.daemonStatus, 'unavailable');
  });

  it('sets the visible artifact via artifact/show', () => {
    const artifact: ArtifactViewState = {
      artifactId: 'art-1',
      turnId: 'turn-1',
      kind: 'code',
      label: 'Generated file',
      availability: 'ready',
      previewBlocks: [],
    };

    const state = reduceWorkspaceState(createInitialWorkspaceState(), {
      type: 'artifact/show',
      artifact,
    });

    assert.deepStrictEqual(state.visibleArtifact, artifact);
  });

  it('clears the visible artifact', () => {
    const artifact = createArtifact();

    let state = reduceWorkspaceState(createInitialWorkspaceState(), {
      type: 'artifact/show',
      artifact,
    });
    state = reduceWorkspaceState(state, { type: 'artifact/clear' });

    assert.equal(state.visibleArtifact, null);
  });

  it('clears the visible artifact when switching conversations', () => {
    let state = createInitialWorkspaceState();
    state = reduceWorkspaceState(state, { type: 'conversation/select', conversationId: 'conv-1' });
    state = reduceWorkspaceState(state, {
      type: 'artifact/show',
      artifact: createArtifact(),
    });
    state = reduceWorkspaceState(state, { type: 'conversation/select', conversationId: 'conv-2' });

    assert.equal(state.activeConversationId, 'conv-2');
    assert.equal(state.visibleArtifact, null);
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
