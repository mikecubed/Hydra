import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createInitialWorkspaceState,
  reduceWorkspaceState,
  type ArtifactViewState,
  type EntryControlState,
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
  selectConversationLineage,
  selectEntryControls,
  selectConversationStaleReason,
  selectIsTurnStale,
  selectCanRetry,
  selectCanBranch,
  selectCanCancel,
  selectCanFollowUp,
  selectEntryActionFlags,
  precomputeTranscriptActions,
  NO_ACTION_FLAGS,
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

// ─── selectConversationLineage ──────────────────────────────────────────────

describe('selectConversationLineage', () => {
  it('returns lineage for a branched conversation', () => {
    let state = createInitialWorkspaceState();
    state = reduceWorkspaceState(state, {
      type: 'conversation/upsert',
      conversation: {
        id: 'conv-branch',
        parentConversationId: 'conv-root',
        forkPointTurnId: 'turn-5',
      },
    });
    state = reduceWorkspaceState(state, {
      type: 'conversation/select',
      conversationId: 'conv-branch',
    });

    const lineage = selectConversationLineage(state);
    assert.notEqual(lineage, null);
    assert.equal(lineage?.sourceConversationId, 'conv-root');
    assert.equal(lineage?.sourceTurnId, 'turn-5');
    assert.equal(lineage?.relationshipKind, 'branch');
  });

  it('returns null for a root conversation', () => {
    const state = stateWithConversation('conv-root');
    assert.equal(selectConversationLineage(state), null);
  });

  it('returns null when no conversation is active', () => {
    assert.equal(selectConversationLineage(createInitialWorkspaceState()), null);
  });
});

// ─── selectEntryControls ────────────────────────────────────────────────────

describe('selectEntryControls', () => {
  it('returns controls for a matching entry', () => {
    const controls: readonly EntryControlState[] = [
      { controlId: 'ctrl-1', kind: 'retry', enabled: true, reasonDisabled: null },
      { controlId: 'ctrl-2', kind: 'branch', enabled: true, reasonDisabled: null },
    ];
    let state = stateWithConversation('conv-1');
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [createEntry({ entryId: 'e1', turnId: 'turn-1', controls })],
      hasMoreHistory: false,
    });

    const result = selectEntryControls(state, 'e1');
    assert.equal(result.length, 2);
    assert.equal(result[0].kind, 'retry');
    assert.equal(result[1].kind, 'branch');
  });

  it('returns empty array for non-existent entry', () => {
    const state = stateWithConversation('conv-1');
    assert.deepStrictEqual(selectEntryControls(state, 'no-such'), []);
  });

  it('returns empty array when no conversation is active', () => {
    assert.deepStrictEqual(selectEntryControls(createInitialWorkspaceState(), 'e1'), []);
  });
});

// ─── selectConversationStaleReason ──────────────────────────────────────────

describe('selectConversationStaleReason', () => {
  it('returns null for a fresh conversation', () => {
    const state = stateWithConversation('conv-1');
    assert.equal(selectConversationStaleReason(state), null);
  });

  it('returns the stale reason after update-control-state', () => {
    let state = stateWithConversation('conv-1');
    state = reduceWorkspaceState(state, {
      type: 'conversation/update-control-state',
      conversationId: 'conv-1',
      patch: { staleReason: 'Session expired' },
    });
    assert.equal(selectConversationStaleReason(state), 'Session expired');
  });

  it('returns null when no conversation is active', () => {
    assert.equal(selectConversationStaleReason(createInitialWorkspaceState()), null);
  });
});

// ─── selectIsTurnStale ──────────────────────────────────────────────────────

describe('selectIsTurnStale', () => {
  it('returns false for a completed turn with no stale entry controls', () => {
    let state = stateWithConversation('conv-1');
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [createEntry({ entryId: 'e1', turnId: 'turn-1', status: 'completed' })],
      hasMoreHistory: false,
    });
    assert.equal(selectIsTurnStale(state, 'turn-1'), false);
  });

  it('returns true for a turn with status stale', () => {
    let state = stateWithConversation('conv-1');
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [createEntry({ entryId: 'e1', turnId: 'turn-1', status: 'stale' })],
      hasMoreHistory: false,
    });
    assert.equal(selectIsTurnStale(state, 'turn-1'), true);
  });

  it('returns false for a non-existent turn', () => {
    const state = stateWithConversation('conv-1');
    assert.equal(selectIsTurnStale(state, 'no-such'), false);
  });
});

// ─── selectCanRetry ─────────────────────────────────────────────────────────

describe('selectCanRetry', () => {
  it('returns true for a completed turn entry', () => {
    let state = stateWithConversation('conv-1');
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [createEntry({ entryId: 'e1', turnId: 'turn-1', status: 'completed' })],
      hasMoreHistory: false,
    });
    assert.equal(selectCanRetry(state, 'turn-1'), true);
  });

  it('returns true for a failed turn entry', () => {
    let state = stateWithConversation('conv-1');
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [createEntry({ entryId: 'e1', turnId: 'turn-1', status: 'failed' })],
      hasMoreHistory: false,
    });
    assert.equal(selectCanRetry(state, 'turn-1'), true);
  });

  it('returns false for an error-status turn (reconciler never produces this)', () => {
    let state = stateWithConversation('conv-1');
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [createEntry({ entryId: 'e1', turnId: 'turn-1', status: 'error' })],
      hasMoreHistory: false,
    });
    assert.equal(selectCanRetry(state, 'turn-1'), false);
  });

  it('returns false for a streaming turn', () => {
    let state = stateWithConversation('conv-1');
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [createEntry({ entryId: 'e1', turnId: 'turn-1', status: 'streaming' })],
      hasMoreHistory: false,
    });
    assert.equal(selectCanRetry(state, 'turn-1'), false);
  });

  it('returns false when conversation is stale', () => {
    let state = stateWithConversation('conv-1');
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [createEntry({ entryId: 'e1', turnId: 'turn-1', status: 'completed' })],
      hasMoreHistory: false,
    });
    state = reduceWorkspaceState(state, {
      type: 'conversation/update-control-state',
      conversationId: 'conv-1',
      patch: { staleReason: 'Session expired' },
    });
    assert.equal(selectCanRetry(state, 'turn-1'), false);
  });

  it('returns false for a non-turn entry', () => {
    let state = stateWithConversation('conv-1');
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [
        createEntry({
          entryId: 'e1',
          kind: 'system-status',
          turnId: null,
          status: 'completed',
        }),
      ],
      hasMoreHistory: false,
    });
    assert.equal(selectCanRetry(state, 'turn-1'), false);
  });

  it('returns false when entry has a disabled retry control despite eligible status', () => {
    let state = stateWithConversation('conv-1');
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [
        createEntry({
          entryId: 'e1',
          turnId: 'turn-1',
          status: 'completed',
          controls: [
            { controlId: 'c1', kind: 'retry', enabled: false, reasonDisabled: 'Rate limited' },
          ],
        }),
      ],
      hasMoreHistory: false,
    });
    assert.equal(selectCanRetry(state, 'turn-1'), false);
  });

  it('returns true when entry has an enabled retry control', () => {
    let state = stateWithConversation('conv-1');
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [
        createEntry({
          entryId: 'e1',
          turnId: 'turn-1',
          status: 'completed',
          controls: [{ controlId: 'c1', kind: 'retry', enabled: true, reasonDisabled: null }],
        }),
      ],
      hasMoreHistory: false,
    });
    assert.equal(selectCanRetry(state, 'turn-1'), true);
  });
});

// ─── selectCanBranch ────────────────────────────────────────────────────────

describe('selectCanBranch', () => {
  it('returns true for a completed turn entry', () => {
    let state = stateWithConversation('conv-1');
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [createEntry({ entryId: 'e1', turnId: 'turn-1', status: 'completed' })],
      hasMoreHistory: false,
    });
    assert.equal(selectCanBranch(state, 'turn-1'), true);
  });

  it('returns false for a streaming turn', () => {
    let state = stateWithConversation('conv-1');
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [createEntry({ entryId: 'e1', turnId: 'turn-1', status: 'streaming' })],
      hasMoreHistory: false,
    });
    assert.equal(selectCanBranch(state, 'turn-1'), false);
  });

  it('returns false when conversation is stale', () => {
    let state = stateWithConversation('conv-1');
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [createEntry({ entryId: 'e1', turnId: 'turn-1', status: 'completed' })],
      hasMoreHistory: false,
    });
    state = reduceWorkspaceState(state, {
      type: 'conversation/update-control-state',
      conversationId: 'conv-1',
      patch: { staleReason: 'Server disconnect' },
    });
    assert.equal(selectCanBranch(state, 'turn-1'), false);
  });

  it('returns false when entry has a disabled branch control despite eligible status', () => {
    let state = stateWithConversation('conv-1');
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [
        createEntry({
          entryId: 'e1',
          turnId: 'turn-1',
          status: 'completed',
          controls: [
            {
              controlId: 'c1',
              kind: 'branch',
              enabled: false,
              reasonDisabled: 'Branching unavailable',
            },
          ],
        }),
      ],
      hasMoreHistory: false,
    });
    assert.equal(selectCanBranch(state, 'turn-1'), false);
  });

  it('returns true when entry has an enabled branch control', () => {
    let state = stateWithConversation('conv-1');
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [
        createEntry({
          entryId: 'e1',
          turnId: 'turn-1',
          status: 'completed',
          controls: [{ controlId: 'c1', kind: 'branch', enabled: true, reasonDisabled: null }],
        }),
      ],
      hasMoreHistory: false,
    });
    assert.equal(selectCanBranch(state, 'turn-1'), true);
  });
});

// ─── selectCanCancel ────────────────────────────────────────────────────────

describe('selectCanCancel', () => {
  it('returns true for a streaming turn', () => {
    let state = stateWithConversation('conv-1');
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [createEntry({ entryId: 'e1', turnId: 'turn-1', status: 'streaming' })],
      hasMoreHistory: false,
    });
    assert.equal(selectCanCancel(state, 'turn-1'), true);
  });

  it('returns true for an executing turn restored from history', () => {
    let state = stateWithConversation('conv-1');
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [createEntry({ entryId: 'e1', turnId: 'turn-1', status: 'executing' })],
      hasMoreHistory: false,
    });
    assert.equal(selectCanCancel(state, 'turn-1'), true);
  });

  it('returns false for a completed turn', () => {
    let state = stateWithConversation('conv-1');
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [createEntry({ entryId: 'e1', turnId: 'turn-1', status: 'completed' })],
      hasMoreHistory: false,
    });
    assert.equal(selectCanCancel(state, 'turn-1'), false);
  });

  it('returns false for a non-existent turn', () => {
    const state = stateWithConversation('conv-1');
    assert.equal(selectCanCancel(state, 'no-such'), false);
  });

  it('returns false when entry has a disabled cancel control despite streaming status', () => {
    let state = stateWithConversation('conv-1');
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [
        createEntry({
          entryId: 'e1',
          turnId: 'turn-1',
          status: 'streaming',
          controls: [
            {
              controlId: 'c1',
              kind: 'cancel',
              enabled: false,
              reasonDisabled: 'Cancel unavailable',
            },
          ],
        }),
      ],
      hasMoreHistory: false,
    });
    assert.equal(selectCanCancel(state, 'turn-1'), false);
  });

  it('returns true when entry has an enabled cancel control', () => {
    let state = stateWithConversation('conv-1');
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [
        createEntry({
          entryId: 'e1',
          turnId: 'turn-1',
          status: 'streaming',
          controls: [{ controlId: 'c1', kind: 'cancel', enabled: true, reasonDisabled: null }],
        }),
      ],
      hasMoreHistory: false,
    });
    assert.equal(selectCanCancel(state, 'turn-1'), true);
  });
});

// ─── selectCanFollowUp ─────────────────────────────────────────────────────

describe('selectCanFollowUp', () => {
  it('returns true for the last completed turn', () => {
    let state = stateWithConversation('conv-1');
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [
        createEntry({ entryId: 'e1', turnId: 'turn-1', status: 'completed' }),
        createEntry({ entryId: 'e2', turnId: 'turn-2', status: 'completed' }),
      ],
      hasMoreHistory: false,
    });
    assert.equal(selectCanFollowUp(state, 'turn-2'), true);
  });

  it('returns true for the latest completed turn even when a later turn is failed', () => {
    let state = stateWithConversation('conv-1');
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [
        createEntry({ entryId: 'e1', turnId: 'turn-1', status: 'completed' }),
        createEntry({ entryId: 'e2', turnId: 'turn-2', status: 'completed' }),
        createEntry({ entryId: 'e3', turnId: 'turn-3', status: 'failed' }),
      ],
      hasMoreHistory: false,
    });
    assert.equal(selectCanFollowUp(state, 'turn-2'), true);
  });

  it('returns false for a non-last completed turn', () => {
    let state = stateWithConversation('conv-1');
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [
        createEntry({ entryId: 'e1', turnId: 'turn-1', status: 'completed' }),
        createEntry({ entryId: 'e2', turnId: 'turn-2', status: 'completed' }),
      ],
      hasMoreHistory: false,
    });
    assert.equal(selectCanFollowUp(state, 'turn-1'), false);
  });

  it('returns false when conversation is stale', () => {
    let state = stateWithConversation('conv-1');
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [createEntry({ entryId: 'e1', turnId: 'turn-1', status: 'completed' })],
      hasMoreHistory: false,
    });
    state = reduceWorkspaceState(state, {
      type: 'conversation/update-control-state',
      conversationId: 'conv-1',
      patch: { staleReason: 'Timeout' },
    });
    assert.equal(selectCanFollowUp(state, 'turn-1'), false);
  });

  it('returns false for a streaming turn', () => {
    let state = stateWithConversation('conv-1');
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [createEntry({ entryId: 'e1', turnId: 'turn-1', status: 'streaming' })],
      hasMoreHistory: false,
    });
    assert.equal(selectCanFollowUp(state, 'turn-1'), false);
  });

  it('uses deduped entries — duplicate turns do not skew last-turn check', () => {
    let state = stateWithConversation('conv-1');
    // Duplicate turn-2 entries: raw entries have turn-2 appearing twice.
    // Without dedup, the last turn entry might be the duplicate, giving a
    // false positive for turn-1 or incorrect result for turn-2.
    const entries: TranscriptEntryState[] = [
      createEntry({ entryId: 'e1', turnId: 'turn-1', status: 'completed' }),
      createEntry({ entryId: 'e2', turnId: 'turn-2', status: 'completed' }),
      createEntry({ entryId: 'e2-dup', turnId: 'turn-2', status: 'completed' }),
    ];
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries,
      hasMoreHistory: false,
    });
    // turn-2 is the last turn — follow-up allowed
    assert.equal(selectCanFollowUp(state, 'turn-2'), true);
    // turn-1 is not the last turn — follow-up blocked
    assert.equal(selectCanFollowUp(state, 'turn-1'), false);
  });

  it('returns false when entry has a disabled submit-follow-up control despite eligible status', () => {
    let state = stateWithConversation('conv-1');
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [
        createEntry({
          entryId: 'e1',
          turnId: 'turn-1',
          status: 'completed',
          controls: [
            {
              controlId: 'c1',
              kind: 'submit-follow-up',
              enabled: false,
              reasonDisabled: 'Follow-up limit reached',
            },
          ],
        }),
      ],
      hasMoreHistory: false,
    });
    assert.equal(selectCanFollowUp(state, 'turn-1'), false);
  });

  it('returns true when entry has an enabled submit-follow-up control', () => {
    let state = stateWithConversation('conv-1');
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [
        createEntry({
          entryId: 'e1',
          turnId: 'turn-1',
          status: 'completed',
          controls: [
            { controlId: 'c1', kind: 'submit-follow-up', enabled: true, reasonDisabled: null },
          ],
        }),
      ],
      hasMoreHistory: false,
    });
    assert.equal(selectCanFollowUp(state, 'turn-1'), true);
  });
});

// ─── Deduplication safety: lineage & control selectors use canonical entries ─

describe('lineage/control selectors — dedup safety', () => {
  it('selectEntryControls reads deduped entries, not raw', () => {
    const controls: readonly EntryControlState[] = [
      { controlId: 'ctrl-1', kind: 'retry', enabled: true, reasonDisabled: null },
    ];
    const dupeControls: readonly EntryControlState[] = [
      { controlId: 'ctrl-dup', kind: 'branch', enabled: true, reasonDisabled: null },
    ];
    let state = stateWithConversation('conv-1');
    // Duplicate turnId — dedup keeps the first occurrence and drops the second.
    // If raw entries were used, looking up 'e1-dup' would find the ghost entry.
    const entries: TranscriptEntryState[] = [
      createEntry({ entryId: 'e1', turnId: 'turn-1', status: 'completed', controls }),
      createEntry({
        entryId: 'e1-dup',
        turnId: 'turn-1',
        status: 'streaming',
        controls: dupeControls,
      }),
    ];
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries,
      hasMoreHistory: false,
    });
    // After dedup, only e1 survives — controls should come from e1
    const result = selectEntryControls(state, 'e1');
    assert.equal(result.length, 1);
    assert.equal(result[0].kind, 'retry');
    // The duplicate's entryId must not be findable in deduped entries
    const dupResult = selectEntryControls(state, 'e1-dup');
    assert.deepStrictEqual(dupResult, [], 'ghost duplicate entry must not be visible');
  });

  it('selectIsTurnStale reads deduped entries', () => {
    let state = stateWithConversation('conv-1');
    // First entry is stale, duplicate overrides with completed — dedup keeps first
    const entries: TranscriptEntryState[] = [
      createEntry({ entryId: 'e1', turnId: 'turn-1', status: 'stale' }),
      createEntry({ entryId: 'e1-dup', turnId: 'turn-1', status: 'completed' }),
    ];
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries,
      hasMoreHistory: false,
    });
    // Dedup keeps e1 (stale) — the selector should see stale
    assert.equal(selectIsTurnStale(state, 'turn-1'), true);
  });

  it('selectCanRetry reads deduped entries', () => {
    let state = stateWithConversation('conv-1');
    const entries: TranscriptEntryState[] = [
      createEntry({ entryId: 'e1', turnId: 'turn-1', status: 'failed' }),
      createEntry({ entryId: 'e1-dup', turnId: 'turn-1', status: 'streaming' }),
    ];
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries,
      hasMoreHistory: false,
    });
    // Dedup keeps e1 (failed) — retry should be allowed
    assert.equal(selectCanRetry(state, 'turn-1'), true);
  });

  it('selectCanBranch reads deduped entries', () => {
    let state = stateWithConversation('conv-1');
    const entries: TranscriptEntryState[] = [
      createEntry({ entryId: 'e1', turnId: 'turn-1', status: 'completed' }),
      createEntry({ entryId: 'e1-dup', turnId: 'turn-1', status: 'streaming' }),
    ];
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries,
      hasMoreHistory: false,
    });
    // Dedup keeps e1 (completed) — branch should be allowed
    assert.equal(selectCanBranch(state, 'turn-1'), true);
  });

  it('selectCanCancel reads deduped entries', () => {
    let state = stateWithConversation('conv-1');
    const entries: TranscriptEntryState[] = [
      createEntry({ entryId: 'e1', turnId: 'turn-1', status: 'streaming' }),
      createEntry({ entryId: 'e1-dup', turnId: 'turn-1', status: 'completed' }),
    ];
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries,
      hasMoreHistory: false,
    });
    // Dedup keeps e1 (streaming) — cancel should be allowed
    assert.equal(selectCanCancel(state, 'turn-1'), true);
  });
});

// ─── selectEntryActionFlags (combined selector) ─────────────────────────────

describe('selectEntryActionFlags', () => {
  it('returns all-false for an unknown turnId', () => {
    let state = stateWithConversation('conv-1');
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [createEntry({ entryId: 'e1', turnId: 'turn-1', status: 'completed' })],
      hasMoreHistory: false,
    });
    const flags = selectEntryActionFlags(state, 'no-such');
    assert.deepStrictEqual(flags, {
      canCancel: false,
      canRetry: false,
      canBranch: false,
      canFollowUp: false,
    });
  });

  it('returns all-false when there are no entries', () => {
    const state = stateWithConversation('conv-1');
    const flags = selectEntryActionFlags(state, 'turn-1');
    assert.deepStrictEqual(flags, {
      canCancel: false,
      canRetry: false,
      canBranch: false,
      canFollowUp: false,
    });
  });

  it('matches individual selectors for a completed turn (last turn)', () => {
    let state = stateWithConversation('conv-1');
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [createEntry({ entryId: 'e1', turnId: 'turn-1', status: 'completed' })],
      hasMoreHistory: false,
    });
    const flags = selectEntryActionFlags(state, 'turn-1');
    assert.equal(flags.canCancel, selectCanCancel(state, 'turn-1'));
    assert.equal(flags.canRetry, selectCanRetry(state, 'turn-1'));
    assert.equal(flags.canBranch, selectCanBranch(state, 'turn-1'));
    assert.equal(flags.canFollowUp, selectCanFollowUp(state, 'turn-1'));
  });

  it('matches individual selectors for a streaming turn', () => {
    let state = stateWithConversation('conv-1');
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [createEntry({ entryId: 'e1', turnId: 'turn-1', status: 'streaming' })],
      hasMoreHistory: false,
    });
    const flags = selectEntryActionFlags(state, 'turn-1');
    assert.equal(flags.canCancel, true);
    assert.equal(flags.canRetry, false);
    assert.equal(flags.canBranch, false);
    assert.equal(flags.canFollowUp, false);
  });

  it('matches individual selectors for a failed turn', () => {
    let state = stateWithConversation('conv-1');
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [createEntry({ entryId: 'e1', turnId: 'turn-1', status: 'failed' })],
      hasMoreHistory: false,
    });
    const flags = selectEntryActionFlags(state, 'turn-1');
    assert.equal(flags.canCancel, false);
    assert.equal(flags.canRetry, true);
    assert.equal(flags.canBranch, false);
    assert.equal(flags.canFollowUp, false);
  });

  it('canFollowUp is false when the turn is not the last completed', () => {
    let state = stateWithConversation('conv-1');
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [
        createEntry({ entryId: 'e1', turnId: 'turn-1', status: 'completed' }),
        createEntry({ entryId: 'e2', turnId: 'turn-2', status: 'completed' }),
      ],
      hasMoreHistory: false,
    });
    const first = selectEntryActionFlags(state, 'turn-1');
    assert.equal(first.canFollowUp, false);
    const second = selectEntryActionFlags(state, 'turn-2');
    assert.equal(second.canFollowUp, true);
  });

  it('respects explicit controls (overrides defaults)', () => {
    const controls: readonly EntryControlState[] = [
      { controlId: 'ctrl-1', kind: 'retry', enabled: false, reasonDisabled: 'quota' },
      { controlId: 'ctrl-2', kind: 'cancel', enabled: true, reasonDisabled: null },
    ];
    let state = stateWithConversation('conv-1');
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [createEntry({ entryId: 'e1', turnId: 'turn-1', status: 'completed', controls })],
      hasMoreHistory: false,
    });
    const flags = selectEntryActionFlags(state, 'turn-1');
    assert.equal(flags.canRetry, false, 'retry control says disabled');
    assert.equal(flags.canCancel, true, 'cancel control says enabled');
  });

  it('reads deduped entries (matches individual selectors)', () => {
    let state = stateWithConversation('conv-1');
    const entries: TranscriptEntryState[] = [
      createEntry({ entryId: 'e1', turnId: 'turn-1', status: 'failed' }),
      createEntry({ entryId: 'e1-dup', turnId: 'turn-1', status: 'streaming' }),
    ];
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries,
      hasMoreHistory: false,
    });
    // Dedup keeps e1 (failed) — combined selector should agree with individual ones
    const flags = selectEntryActionFlags(state, 'turn-1');
    assert.equal(flags.canRetry, selectCanRetry(state, 'turn-1'));
    assert.equal(flags.canBranch, selectCanBranch(state, 'turn-1'));
    assert.equal(flags.canCancel, selectCanCancel(state, 'turn-1'));
  });

  it('handles stale conversation (all non-cancel flags false)', () => {
    let state = stateWithConversation('conv-1');
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [createEntry({ entryId: 'e1', turnId: 'turn-1', status: 'completed' })],
      hasMoreHistory: false,
    });
    state = reduceWorkspaceState(state, {
      type: 'conversation/update-control-state',
      conversationId: 'conv-1',
      patch: { staleReason: 'Session expired' },
    });
    const flags = selectEntryActionFlags(state, 'turn-1');
    assert.equal(flags.canRetry, false, 'stale blocks retry');
    assert.equal(flags.canBranch, false, 'stale blocks branch');
    assert.equal(flags.canFollowUp, false, 'stale blocks follow-up');
  });
});

// ─── precomputeTranscriptActions (whole-transcript precompute) ───────────────

describe('precomputeTranscriptActions', () => {
  it('returns an empty map when there are no entries', () => {
    const state = stateWithConversation('conv-1');
    const map = precomputeTranscriptActions(state);
    assert.equal(map.size, 0);
  });

  it('returns an empty map when there is no active conversation', () => {
    const state = createInitialWorkspaceState();
    const map = precomputeTranscriptActions(state);
    assert.equal(map.size, 0);
  });

  it('computes flags for a single completed turn', () => {
    let state = stateWithConversation('conv-1');
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [createEntry({ entryId: 'e1', turnId: 'turn-1', status: 'completed' })],
      hasMoreHistory: false,
    });
    const map = precomputeTranscriptActions(state);
    assert.equal(map.size, 1);
    const flags = map.get('turn-1');
    assert.ok(flags != null);
    assert.equal(flags.canCancel, false);
    assert.equal(flags.canRetry, true);
    assert.equal(flags.canBranch, true);
    assert.equal(flags.canFollowUp, true, 'last completed turn gets follow-up');
  });

  it('computes flags for a streaming turn', () => {
    let state = stateWithConversation('conv-1');
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [createEntry({ entryId: 'e1', turnId: 'turn-1', status: 'streaming' })],
      hasMoreHistory: false,
    });
    const map = precomputeTranscriptActions(state);
    const flags = map.get('turn-1');
    assert.ok(flags != null);
    assert.equal(flags.canCancel, true);
    assert.equal(flags.canRetry, false);
    assert.equal(flags.canBranch, false);
    assert.equal(flags.canFollowUp, false);
  });

  it('computes flags for a failed turn', () => {
    let state = stateWithConversation('conv-1');
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [createEntry({ entryId: 'e1', turnId: 'turn-1', status: 'failed' })],
      hasMoreHistory: false,
    });
    const map = precomputeTranscriptActions(state);
    const flags = map.get('turn-1');
    assert.ok(flags != null);
    assert.equal(flags.canCancel, false);
    assert.equal(flags.canRetry, true);
    assert.equal(flags.canBranch, false);
    assert.equal(flags.canFollowUp, false);
  });

  it('only grants canFollowUp to the last completed turn', () => {
    let state = stateWithConversation('conv-1');
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [
        createEntry({ entryId: 'e1', turnId: 'turn-1', status: 'completed' }),
        createEntry({ entryId: 'e2', turnId: 'turn-2', status: 'completed' }),
        createEntry({ entryId: 'e3', turnId: 'turn-3', status: 'completed' }),
      ],
      hasMoreHistory: false,
    });
    const map = precomputeTranscriptActions(state);
    assert.equal(map.size, 3);
    assert.equal(map.get('turn-1')!.canFollowUp, false);
    assert.equal(map.get('turn-2')!.canFollowUp, false);
    assert.equal(map.get('turn-3')!.canFollowUp, true);
  });

  it('agrees with per-entry selectEntryActionFlags for every turn', () => {
    let state = stateWithConversation('conv-1');
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [
        createEntry({ entryId: 'e1', turnId: 'turn-1', status: 'completed' }),
        createEntry({ entryId: 'e2', turnId: 'turn-2', status: 'streaming' }),
        createEntry({ entryId: 'e3', turnId: 'turn-3', status: 'failed' }),
      ],
      hasMoreHistory: false,
    });
    const map = precomputeTranscriptActions(state);
    for (const [turnId, precomputed] of map) {
      const perEntry = selectEntryActionFlags(state, turnId);
      assert.deepStrictEqual(precomputed, perEntry, `mismatch for ${turnId}`);
    }
  });

  it('respects explicit controls', () => {
    const controls: readonly EntryControlState[] = [
      { controlId: 'ctrl-1', kind: 'retry', enabled: false, reasonDisabled: 'quota' },
      { controlId: 'ctrl-2', kind: 'cancel', enabled: true, reasonDisabled: null },
    ];
    let state = stateWithConversation('conv-1');
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [createEntry({ entryId: 'e1', turnId: 'turn-1', status: 'completed', controls })],
      hasMoreHistory: false,
    });
    const map = precomputeTranscriptActions(state);
    const flags = map.get('turn-1')!;
    assert.equal(flags.canRetry, false, 'retry control disabled');
    assert.equal(flags.canCancel, true, 'cancel control enabled');
  });

  it('blocks all non-cancel flags for a stale conversation', () => {
    let state = stateWithConversation('conv-1');
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [createEntry({ entryId: 'e1', turnId: 'turn-1', status: 'completed' })],
      hasMoreHistory: false,
    });
    state = reduceWorkspaceState(state, {
      type: 'conversation/update-control-state',
      conversationId: 'conv-1',
      patch: { staleReason: 'Session expired' },
    });
    const map = precomputeTranscriptActions(state);
    const flags = map.get('turn-1')!;
    assert.equal(flags.canRetry, false);
    assert.equal(flags.canBranch, false);
    assert.equal(flags.canFollowUp, false);
  });

  it('skips non-turn entries', () => {
    let state = stateWithConversation('conv-1');
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [
        createEntry({ entryId: 'e1', kind: 'prompt', turnId: null, status: 'completed' }),
        createEntry({ entryId: 'e2', turnId: 'turn-1', status: 'completed' }),
      ],
      hasMoreHistory: false,
    });
    const map = precomputeTranscriptActions(state);
    assert.equal(map.size, 1, 'only turn entry in map');
    assert.ok(map.has('turn-1'));
  });

  it('handles deduped entries correctly', () => {
    let state = stateWithConversation('conv-1');
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [
        createEntry({ entryId: 'e1', turnId: 'turn-1', status: 'completed' }),
        createEntry({ entryId: 'e1-dup', turnId: 'turn-1', status: 'streaming' }),
      ],
      hasMoreHistory: false,
    });
    const map = precomputeTranscriptActions(state);
    // Dedup keeps e1 (completed) — should agree with per-entry selector
    const flags = map.get('turn-1')!;
    assert.equal(flags.canRetry, selectCanRetry(state, 'turn-1'));
    assert.equal(flags.canBranch, selectCanBranch(state, 'turn-1'));
    assert.equal(flags.canCancel, selectCanCancel(state, 'turn-1'));
  });
});

// ─── NO_ACTION_FLAGS export ─────────────────────────────────────────────────

describe('NO_ACTION_FLAGS', () => {
  it('is a frozen all-false sentinel', () => {
    assert.equal(Object.isFrozen(NO_ACTION_FLAGS), true);
    assert.deepStrictEqual(NO_ACTION_FLAGS, {
      canCancel: false,
      canRetry: false,
      canBranch: false,
      canFollowUp: false,
    });
  });
});
