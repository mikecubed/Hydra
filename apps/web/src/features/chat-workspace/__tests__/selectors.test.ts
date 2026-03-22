import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createInitialWorkspaceState,
  reduceWorkspaceState,
  type ArtifactViewState,
  type TranscriptEntryState,
  type WorkspaceState,
} from '../model/workspace-store.ts';

import {
  selectActiveConversation,
  selectActiveDraft,
  selectActiveEntries,
  selectActiveLoadState,
  selectVisibleArtifact,
  selectCanSubmit,
  selectCreateModeCanSubmit,
  selectConversationList,
  selectIsHistoryLoaded,
} from '../model/selectors.ts';

// ─── Helpers ────────────────────────────────────────────────────────────────

function stateWithConversation(conversationId: string): WorkspaceState {
  return reduceWorkspaceState(createInitialWorkspaceState(), {
    type: 'conversation/select',
    conversationId,
  });
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

// ─── selectActiveConversation ───────────────────────────────────────────────

describe('selectActiveConversation', () => {
  it('returns the active conversation view state', () => {
    const state = stateWithConversation('conv-1');
    const conv = selectActiveConversation(state);
    assert.equal(conv?.conversationId, 'conv-1');
  });

  it('returns undefined when no conversation is active', () => {
    const state = createInitialWorkspaceState();
    assert.equal(selectActiveConversation(state), undefined);
  });
});

// ─── selectActiveDraft ──────────────────────────────────────────────────────

describe('selectActiveDraft', () => {
  it('returns the draft for the active conversation', () => {
    let state = stateWithConversation('conv-1');
    state = reduceWorkspaceState(state, {
      type: 'draft/set-text',
      conversationId: 'conv-1',
      draftText: 'test text',
    });

    const draft = selectActiveDraft(state);
    assert.equal(draft?.draftText, 'test text');
    assert.equal(draft?.conversationId, 'conv-1');
  });

  it('returns undefined when no conversation is active', () => {
    assert.equal(selectActiveDraft(createInitialWorkspaceState()), undefined);
  });
});

// ─── selectActiveEntries ────────────────────────────────────────────────────

describe('selectActiveEntries', () => {
  it('returns entries for the active conversation', () => {
    let state = stateWithConversation('conv-1');
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [createEntry(), createEntry({ entryId: 'entry-2', turnId: 'turn-2' })],
      hasMoreHistory: false,
    });

    const entries = selectActiveEntries(state);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].entryId, 'entry-1');
    assert.equal(entries[1].entryId, 'entry-2');
  });

  it('returns an empty array when no conversation is active', () => {
    const entries = selectActiveEntries(createInitialWorkspaceState());
    assert.deepStrictEqual(entries, []);
  });

  it('returns an empty array when the active conversation has no entries', () => {
    const state = stateWithConversation('conv-1');
    const entries = selectActiveEntries(state);
    assert.deepStrictEqual(entries, []);
  });
});

// ─── selectActiveLoadState ──────────────────────────────────────────────────

describe('selectActiveLoadState', () => {
  it('returns the load state of the active conversation', () => {
    let state = stateWithConversation('conv-1');
    state = reduceWorkspaceState(state, {
      type: 'conversation/set-load-state',
      conversationId: 'conv-1',
      loadState: 'loading',
    });

    assert.equal(selectActiveLoadState(state), 'loading');
  });

  it('returns null when no conversation is active', () => {
    assert.equal(selectActiveLoadState(createInitialWorkspaceState()), null);
  });
});

// ─── selectVisibleArtifact ──────────────────────────────────────────────────

describe('selectVisibleArtifact', () => {
  it('returns the visible artifact when set', () => {
    const artifact = createArtifact();
    const state = reduceWorkspaceState(createInitialWorkspaceState(), {
      type: 'artifact/show',
      artifact,
    });

    assert.deepStrictEqual(selectVisibleArtifact(state), artifact);
  });

  it('returns null when no artifact is visible', () => {
    assert.equal(selectVisibleArtifact(createInitialWorkspaceState()), null);
  });
});

// ─── selectCanSubmit ────────────────────────────────────────────────────────

describe('selectCanSubmit', () => {
  it('returns true when draft is non-empty, idle, and conversation allows submission', () => {
    let state = stateWithConversation('conv-1');
    state = reduceWorkspaceState(state, {
      type: 'draft/set-text',
      conversationId: 'conv-1',
      draftText: 'submit me',
    });

    assert.equal(selectCanSubmit(state), true);
  });

  it('returns false when draft is empty', () => {
    const state = stateWithConversation('conv-1');
    assert.equal(selectCanSubmit(state), false);
  });

  it('returns false when draft is submitting', () => {
    let state = stateWithConversation('conv-1');
    state = reduceWorkspaceState(state, {
      type: 'draft/set-text',
      conversationId: 'conv-1',
      draftText: 'submit me',
    });
    state = reduceWorkspaceState(state, {
      type: 'draft/set-submit-state',
      conversationId: 'conv-1',
      submitState: 'submitting',
      validationMessage: null,
    });

    assert.equal(selectCanSubmit(state), false);
  });

  it('returns false when no conversation is active', () => {
    assert.equal(selectCanSubmit(createInitialWorkspaceState()), false);
  });

  it('returns false when draft has an error', () => {
    let state = stateWithConversation('conv-1');
    state = reduceWorkspaceState(state, {
      type: 'draft/set-text',
      conversationId: 'conv-1',
      draftText: 'submit me',
    });
    state = reduceWorkspaceState(state, {
      type: 'draft/set-submit-state',
      conversationId: 'conv-1',
      submitState: 'error',
      validationMessage: 'Too long',
    });

    assert.equal(selectCanSubmit(state), false);
  });
});

// ─── selectConversationList ─────────────────────────────────────────────────

describe('selectConversationList', () => {
  it('returns conversations in order', () => {
    let state = createInitialWorkspaceState();
    state = reduceWorkspaceState(state, {
      type: 'conversation/upsert',
      conversation: { id: 'conv-1', title: 'First' },
    });
    state = reduceWorkspaceState(state, {
      type: 'conversation/upsert',
      conversation: { id: 'conv-2', title: 'Second' },
    });

    const list = selectConversationList(state);
    assert.equal(list.length, 2);
    assert.equal(list[0].conversationId, 'conv-1');
    assert.equal(list[0].title, 'First');
    assert.equal(list[1].conversationId, 'conv-2');
    assert.equal(list[1].title, 'Second');
  });

  it('returns an empty array when there are no conversations', () => {
    assert.deepStrictEqual(selectConversationList(createInitialWorkspaceState()), []);
  });

  it('preserves order after replace-all', () => {
    let state = createInitialWorkspaceState();
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-all',
      conversations: [
        { id: 'conv-b', title: 'B' },
        { id: 'conv-a', title: 'A' },
      ],
    });

    const list = selectConversationList(state);
    assert.equal(list[0].conversationId, 'conv-b');
    assert.equal(list[1].conversationId, 'conv-a');
  });
});

// ─── selectCreateModeCanSubmit ──────────────────────────────────────────────

describe('selectCreateModeCanSubmit', () => {
  it('returns true when draft has text, not submitting, no error', () => {
    assert.equal(selectCreateModeCanSubmit('hello', false, null), true);
  });

  it('returns false when draft text is empty', () => {
    assert.equal(selectCreateModeCanSubmit('', false, null), false);
  });

  it('returns false when draft text is whitespace-only', () => {
    assert.equal(selectCreateModeCanSubmit('   \n\t', false, null), false);
  });

  it('returns false when currently submitting', () => {
    assert.equal(selectCreateModeCanSubmit('hello', true, null), false);
  });

  it('returns false when there is an outstanding create error', () => {
    assert.equal(selectCreateModeCanSubmit('hello', false, 'Gateway 503'), false);
  });

  it('returns false when submitting and error both present', () => {
    assert.equal(selectCreateModeCanSubmit('hello', true, 'some error'), false);
  });

  it('returns true for text with leading/trailing whitespace', () => {
    assert.equal(selectCreateModeCanSubmit('  hello  ', false, null), true);
  });
});

// ─── selectIsHistoryLoaded ──────────────────────────────────────────────────

describe('selectIsHistoryLoaded', () => {
  it('returns false when no conversation is active', () => {
    assert.equal(selectIsHistoryLoaded(createInitialWorkspaceState()), false);
  });

  it('returns false when historyLoaded is false (default)', () => {
    const state = stateWithConversation('conv-1');
    assert.equal(selectIsHistoryLoaded(state), false);
  });

  it('returns true after merge-history has been dispatched', () => {
    let state = stateWithConversation('conv-1');
    state = reduceWorkspaceState(state, {
      type: 'conversation/merge-history',
      conversationId: 'conv-1',
      entries: [createEntry()],
      hasMoreHistory: false,
    });
    assert.equal(selectIsHistoryLoaded(state), true);
  });
});

// ─── selectActiveEntries — duplicate suppression ────────────────────────────

describe('selectActiveEntries — duplicate suppression', () => {
  it('returns same array reference when no duplicates', () => {
    let state = stateWithConversation('conv-1');
    const entries = [createEntry({ entryId: 'e1', turnId: 'turn-1' })];
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries,
      hasMoreHistory: false,
    });
    const conv = state.conversations.get('conv-1');
    const selected = selectActiveEntries(state);
    // Should reference the same array stored in state (no unnecessary copy)
    assert.equal(selected, conv?.entries);
  });

  it('deduplicates entries with same turnId', () => {
    let state = stateWithConversation('conv-1');
    // Manually construct state with duplicate turnIds (simulating a bug/race)
    const dupEntries: TranscriptEntryState[] = [
      createEntry({ entryId: 'e1', turnId: 'turn-1', status: 'completed' }),
      createEntry({ entryId: 'e2', turnId: 'turn-1', status: 'streaming' }),
      createEntry({ entryId: 'e3', turnId: 'turn-2', status: 'completed' }),
    ];
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: dupEntries,
      hasMoreHistory: false,
    });
    const selected = selectActiveEntries(state);
    assert.equal(selected.length, 2);
    // First occurrence of turn-1 is kept (entryId 'e1')
    assert.equal(selected[0].entryId, 'e1');
    assert.equal(selected[1].entryId, 'e3');
  });

  it('deduplicates non-turn entries with same entryId', () => {
    let state = stateWithConversation('conv-1');
    const dupEntries: TranscriptEntryState[] = [
      createEntry({ entryId: 'e1', turnId: 'turn-1', status: 'completed' }),
      createEntry({
        entryId: 'sys-1',
        kind: 'system-status',
        turnId: 'turn-1',
        status: 'warning',
      }),
      createEntry({
        entryId: 'sys-1',
        kind: 'system-status',
        turnId: 'turn-1',
        status: 'warning',
      }),
    ];
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: dupEntries,
      hasMoreHistory: false,
    });
    const selected = selectActiveEntries(state);
    assert.equal(selected.length, 2, 'duplicate non-turn entry must be removed');
    assert.equal(selected[0].entryId, 'e1');
    assert.equal(selected[1].entryId, 'sys-1');
  });

  it('deduplicates mixed turn and non-turn duplicates', () => {
    let state = stateWithConversation('conv-1');
    const dupEntries: TranscriptEntryState[] = [
      createEntry({ entryId: 'e1', turnId: 'turn-1', status: 'completed' }),
      createEntry({
        entryId: 'act-1',
        kind: 'activity-group',
        turnId: 'turn-1',
        status: 'active',
      }),
      createEntry({
        entryId: 'act-1',
        kind: 'activity-group',
        turnId: 'turn-1',
        status: 'active',
      }),
      createEntry({ entryId: 'e2', turnId: 'turn-2', status: 'completed' }),
    ];
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: dupEntries,
      hasMoreHistory: false,
    });
    const selected = selectActiveEntries(state);
    assert.equal(selected.length, 3, 'duplicate activity-group must be removed');
    assert.equal(selected[0].entryId, 'e1');
    assert.equal(selected[1].entryId, 'act-1');
    assert.equal(selected[2].entryId, 'e2');
  });
});
