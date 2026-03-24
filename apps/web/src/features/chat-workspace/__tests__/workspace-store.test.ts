import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createInitialWorkspaceState,
  createWorkspaceStore,
  reduceWorkspaceState,
  submitComposerDraft,
  createAndSubmitDraft,
  type ArtifactViewState,
  type SubmitDraftDeps,
  type SubmitResult,
  type TranscriptEntryState,
  type WorkspaceConversationRecord,
  type WorkspaceStore,
} from '../model/workspace-store.ts';

import { invalidateStaleEntryControls } from '../model/reconciler.ts';

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

  it('replace-all preserves explicit create mode and does not auto-select first conversation', () => {
    let state = createInitialWorkspaceState();
    // User selects a conversation, then explicitly enters create mode.
    state = reduceWorkspaceState(state, { type: 'conversation/select', conversationId: 'conv-1' });
    state = reduceWorkspaceState(state, { type: 'conversation/select', conversationId: null });
    assert.equal(state.explicitCreateMode, true);

    // Background reload arrives with conversations.
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-all',
      conversations: [
        createConversation(),
        createConversation({ id: 'conv-2', title: 'Second conversation' }),
      ],
    });

    // The explicit create mode must survive; activeConversationId stays null.
    assert.equal(state.activeConversationId, null);
    assert.equal(state.explicitCreateMode, true);
  });

  it('replace-all auto-selects first conversation when not in explicit create mode', () => {
    const state = reduceWorkspaceState(createInitialWorkspaceState(), {
      type: 'conversation/replace-all',
      conversations: [
        createConversation(),
        createConversation({ id: 'conv-2', title: 'Second conversation' }),
      ],
    });

    // Initial load (not explicit create mode) should auto-select.
    assert.equal(state.explicitCreateMode, false);
    assert.equal(state.activeConversationId, 'conv-1');
  });

  it('replace-all retains the active conversation when the refresh payload omits it', () => {
    let state = createInitialWorkspaceState();
    // Simulate a just-created conversation that is selected and known locally.
    state = reduceWorkspaceState(state, {
      type: 'conversation/upsert',
      conversation: createConversation({ id: 'conv-new', title: 'Just created' }),
    });
    state = reduceWorkspaceState(state, {
      type: 'conversation/select',
      conversationId: 'conv-new',
    });

    // Background list refresh arrives but does NOT include conv-new (stale page).
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-all',
      conversations: [
        createConversation({ id: 'conv-a', title: 'Older A' }),
        createConversation({ id: 'conv-b', title: 'Older B' }),
      ],
    });

    // The active conversation must survive — it was already known locally.
    assert.equal(state.activeConversationId, 'conv-new');
    assert.ok(state.conversations.has('conv-new'), 'active conversation retained in map');
    assert.ok(
      state.conversationOrder.includes('conv-new'),
      'active conversation retained in order',
    );
    // The other conversations from the payload should still be present.
    assert.ok(state.conversations.has('conv-a'));
    assert.ok(state.conversations.has('conv-b'));
  });

  it('replace-all retains the draft of the active conversation when the refresh omits it', () => {
    let state = createInitialWorkspaceState();
    state = reduceWorkspaceState(state, {
      type: 'conversation/upsert',
      conversation: createConversation({ id: 'conv-new', title: 'Just created' }),
    });
    state = reduceWorkspaceState(state, {
      type: 'conversation/select',
      conversationId: 'conv-new',
    });
    state = reduceWorkspaceState(state, {
      type: 'draft/set-text',
      conversationId: 'conv-new',
      draftText: 'My important draft',
    });

    // Background refresh omits conv-new.
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-all',
      conversations: [createConversation({ id: 'conv-a', title: 'Older A' })],
    });

    // Draft must survive.
    assert.equal(state.drafts.get('conv-new')?.draftText, 'My important draft');
  });

  it('replace-all still prunes non-active conversations absent from the payload', () => {
    let state = createInitialWorkspaceState();
    // Two conversations exist; conv-1 is active.
    state = reduceWorkspaceState(state, {
      type: 'conversation/upsert',
      conversation: createConversation({ id: 'conv-1', title: 'Active' }),
    });
    state = reduceWorkspaceState(state, {
      type: 'conversation/upsert',
      conversation: createConversation({ id: 'conv-old', title: 'Stale' }),
    });
    state = reduceWorkspaceState(state, {
      type: 'conversation/select',
      conversationId: 'conv-1',
    });
    state = reduceWorkspaceState(state, {
      type: 'draft/set-text',
      conversationId: 'conv-old',
      draftText: 'Orphaned draft',
    });

    // Refresh includes conv-1 but NOT conv-old.
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-all',
      conversations: [createConversation({ id: 'conv-1', title: 'Active refreshed' })],
    });

    // conv-old and its draft should be pruned (non-active).
    assert.ok(!state.conversations.has('conv-old'), 'non-active conversation pruned');
    assert.ok(!state.conversationOrder.includes('conv-old'), 'pruned from order');
    assert.equal(state.drafts.has('conv-old'), false, 'orphaned draft pruned');
    // Active conversation stays.
    assert.equal(state.activeConversationId, 'conv-1');
  });

  it('selecting a conversation clears explicit create mode', () => {
    let state = createInitialWorkspaceState();
    state = reduceWorkspaceState(state, { type: 'conversation/select', conversationId: null });
    assert.equal(state.explicitCreateMode, true);

    state = reduceWorkspaceState(state, { type: 'conversation/select', conversationId: 'conv-1' });
    assert.equal(state.explicitCreateMode, false);
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

// ─── Submit flow helpers ────────────────────────────────────────────────────

function createMockClient(
  overrides: Partial<SubmitDraftDeps['client']> = {},
): SubmitDraftDeps['client'] {
  return {
    createConversation:
      overrides.createConversation ??
      (async () => ({
        id: 'new-conv',
        title: undefined,
        status: 'active' as const,
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:00:00.000Z',
        turnCount: 0,
        pendingInstructionCount: 0,
      })),
    submitInstruction:
      overrides.submitInstruction ??
      (async () => ({
        turn: {
          id: 'turn-1',
          conversationId: 'conv-1',
          position: 1,
          kind: 'operator' as const,
          attribution: { type: 'operator' as const, label: 'Operator' },
          instruction: 'hello',
          status: 'submitted' as const,
          createdAt: '2026-04-01T00:00:00.000Z',
        },
        streamId: 'stream-1',
      })),
  };
}

function storeWithActiveDraft(conversationId: string, draftText: string): WorkspaceStore {
  const store = createWorkspaceStore();
  store.dispatch({ type: 'conversation/select', conversationId });
  if (draftText !== '') {
    store.dispatch({ type: 'draft/set-text', conversationId, draftText });
  }
  return store;
}

// ─── submitComposerDraft (continue flow) ────────────────────────────────────

describe('submitComposerDraft', () => {
  it('submits instruction and clears draft on success', async () => {
    const store = storeWithActiveDraft('conv-1', 'hello agent');
    const submitted: Array<{ conversationId: string; instruction: string }> = [];

    const client = createMockClient({
      submitInstruction: async (convId, body) => {
        submitted.push({ conversationId: convId, instruction: body.instruction });
        return {
          turn: {
            id: 'turn-1',
            conversationId: convId,
            position: 1,
            kind: 'operator' as const,
            attribution: { type: 'operator' as const, label: 'Operator' },
            instruction: body.instruction,
            status: 'submitted' as const,
            createdAt: '2026-04-01T00:00:00.000Z',
          },
          streamId: 'stream-1',
        };
      },
    });

    const result = await submitComposerDraft({ store, client });

    assert.deepStrictEqual(submitted, [{ conversationId: 'conv-1', instruction: 'hello agent' }]);
    assert.equal(store.getState().drafts.get('conv-1')?.draftText, '');
    assert.equal(store.getState().drafts.get('conv-1')?.submitState, 'idle');
    assert.equal(store.getState().drafts.get('conv-1')?.validationMessage, null);
    assert.equal(result.ok, true);
  });

  it('transitions through submitting state during request', async () => {
    const store = storeWithActiveDraft('conv-1', 'check state');
    const observedStates: string[] = [];

    let resolveSubmit!: () => void;
    const submitPromise = new Promise<void>((resolve) => {
      resolveSubmit = resolve;
    });

    const client = createMockClient({
      submitInstruction: async () => {
        observedStates.push(store.getState().drafts.get('conv-1')?.submitState ?? 'missing');
        resolveSubmit();
        return {
          turn: {
            id: 'turn-1',
            conversationId: 'conv-1',
            position: 1,
            kind: 'operator' as const,
            attribution: { type: 'operator' as const, label: 'Operator' },
            instruction: 'check state',
            status: 'submitted' as const,
            createdAt: '2026-04-01T00:00:00.000Z',
          },
          streamId: 'stream-1',
        };
      },
    });

    const result = submitComposerDraft({ store, client });
    await submitPromise;
    assert.deepStrictEqual(observedStates, ['submitting']);
    await result;
    assert.equal(store.getState().drafts.get('conv-1')?.submitState, 'idle');
  });

  it('sets error state when submission fails', async () => {
    const store = storeWithActiveDraft('conv-1', 'will fail');

    const client = createMockClient({
      submitInstruction: async () => {
        throw new Error('Gateway 502: Bad Gateway');
      },
    });

    const result = await submitComposerDraft({ store, client });

    const draft = store.getState().drafts.get('conv-1');
    assert.equal(draft?.submitState, 'error');
    assert.equal(draft?.validationMessage, 'Gateway 502: Bad Gateway');
    assert.equal(draft?.draftText, 'will fail');
    assert.equal(result.ok, false);
  });

  it('preserves draft text on submission error', async () => {
    const store = storeWithActiveDraft('conv-1', 'precious text');

    const client = createMockClient({
      submitInstruction: async () => {
        throw new Error('Network error');
      },
    });

    await submitComposerDraft({ store, client });

    assert.equal(store.getState().drafts.get('conv-1')?.draftText, 'precious text');
  });

  it('does nothing when no active conversation', async () => {
    const store = createWorkspaceStore();
    let called = false;

    const client = createMockClient({
      submitInstruction: async () => {
        called = true;
        return {
          turn: {
            id: 'turn-1',
            conversationId: 'conv-1',
            position: 1,
            kind: 'operator' as const,
            attribution: { type: 'operator' as const, label: 'Operator' },
            instruction: '',
            status: 'submitted' as const,
            createdAt: '2026-04-01T00:00:00.000Z',
          },
          streamId: 'stream-1',
        };
      },
    });

    const result = await submitComposerDraft({ store, client });
    assert.equal(called, false);
    assert.equal(result.ok, false);
  });

  it('does nothing when draft is empty', async () => {
    const store = storeWithActiveDraft('conv-1', '');
    let called = false;

    const client = createMockClient({
      submitInstruction: async () => {
        called = true;
        return {
          turn: {
            id: 'turn-1',
            conversationId: 'conv-1',
            position: 1,
            kind: 'operator' as const,
            attribution: { type: 'operator' as const, label: 'Operator' },
            instruction: '',
            status: 'submitted' as const,
            createdAt: '2026-04-01T00:00:00.000Z',
          },
          streamId: 'stream-1',
        };
      },
    });

    await submitComposerDraft({ store, client });
    assert.equal(called, false);
  });

  it('does nothing when draft is whitespace-only', async () => {
    const store = storeWithActiveDraft('conv-1', '   \n\t  ');
    let called = false;

    const client = createMockClient({
      submitInstruction: async () => {
        called = true;
        return {
          turn: {
            id: 'turn-1',
            conversationId: 'conv-1',
            position: 1,
            kind: 'operator' as const,
            attribution: { type: 'operator' as const, label: 'Operator' },
            instruction: '',
            status: 'submitted' as const,
            createdAt: '2026-04-01T00:00:00.000Z',
          },
          streamId: 'stream-1',
        };
      },
    });

    await submitComposerDraft({ store, client });
    assert.equal(called, false);
  });

  it('does nothing when draft is already submitting', async () => {
    const store = storeWithActiveDraft('conv-1', 'in flight');
    store.dispatch({
      type: 'draft/set-submit-state',
      conversationId: 'conv-1',
      submitState: 'submitting',
      validationMessage: null,
    });

    let called = false;
    const client = createMockClient({
      submitInstruction: async () => {
        called = true;
        return {
          turn: {
            id: 'turn-1',
            conversationId: 'conv-1',
            position: 1,
            kind: 'operator' as const,
            attribution: { type: 'operator' as const, label: 'Operator' },
            instruction: '',
            status: 'submitted' as const,
            createdAt: '2026-04-01T00:00:00.000Z',
          },
          streamId: 'stream-1',
        };
      },
    });

    await submitComposerDraft({ store, client });
    assert.equal(called, false);
  });

  it('trims whitespace from instruction before submitting', async () => {
    const store = storeWithActiveDraft('conv-1', '  padded text  ');
    const submitted: string[] = [];

    const client = createMockClient({
      submitInstruction: async (_convId, body) => {
        submitted.push(body.instruction);
        return {
          turn: {
            id: 'turn-1',
            conversationId: 'conv-1',
            position: 1,
            kind: 'operator' as const,
            attribution: { type: 'operator' as const, label: 'Operator' },
            instruction: body.instruction,
            status: 'submitted' as const,
            createdAt: '2026-04-01T00:00:00.000Z',
          },
          streamId: 'stream-1',
        };
      },
    });

    await submitComposerDraft({ store, client });
    assert.deepStrictEqual(submitted, ['padded text']);
  });

  it('uses generic message for non-Error throws', async () => {
    const store = storeWithActiveDraft('conv-1', 'will fail');

    const client = createMockClient({
      submitInstruction: async () => {
        throw { code: 'UNKNOWN' }; // eslint-disable-line @typescript-eslint/only-throw-error -- testing non-Error throw handling
      },
    });

    await submitComposerDraft({ store, client });

    assert.equal(store.getState().drafts.get('conv-1')?.validationMessage, 'Submission failed');
  });
});

// ─── createAndSubmitDraft (create flow) ─────────────────────────────────────

describe('createAndSubmitDraft', () => {
  it('creates a conversation, selects it, and submits the instruction', async () => {
    const store = createWorkspaceStore();
    const createdIds: string[] = [];
    const submitted: Array<{ conversationId: string; instruction: string }> = [];

    const client = createMockClient({
      createConversation: async () => {
        createdIds.push('new-conv');
        return {
          id: 'new-conv',
          title: undefined,
          status: 'active' as const,
          createdAt: '2026-04-01T00:00:00.000Z',
          updatedAt: '2026-04-01T00:00:00.000Z',
          turnCount: 0,
          pendingInstructionCount: 0,
        };
      },
      submitInstruction: async (convId, body) => {
        submitted.push({ conversationId: convId, instruction: body.instruction });
        return {
          turn: {
            id: 'turn-1',
            conversationId: convId,
            position: 1,
            kind: 'operator' as const,
            attribution: { type: 'operator' as const, label: 'Operator' },
            instruction: body.instruction,
            status: 'submitted' as const,
            createdAt: '2026-04-01T00:00:00.000Z',
          },
          streamId: 'stream-1',
        };
      },
    });

    const result = await createAndSubmitDraft({ store, client }, 'first message');

    assert.deepStrictEqual(createdIds, ['new-conv']);
    assert.deepStrictEqual(submitted, [
      { conversationId: 'new-conv', instruction: 'first message' },
    ]);
    assert.equal(store.getState().activeConversationId, 'new-conv');
    assert.equal(store.getState().drafts.get('new-conv')?.draftText, '');
    assert.equal(store.getState().drafts.get('new-conv')?.submitState, 'idle');
    assert.equal(result.ok, true);
  });

  it('does nothing when draft text is empty', async () => {
    const store = createWorkspaceStore();
    let called = false;

    const client = createMockClient({
      createConversation: async () => {
        called = true;
        return {
          id: 'new-conv',
          title: undefined,
          status: 'active' as const,
          createdAt: '2026-04-01T00:00:00.000Z',
          updatedAt: '2026-04-01T00:00:00.000Z',
          turnCount: 0,
          pendingInstructionCount: 0,
        };
      },
    });

    const result = await createAndSubmitDraft({ store, client }, '');
    assert.equal(called, false);
    assert.equal(result.ok, false);
  });

  it('does nothing when draft text is whitespace-only', async () => {
    const store = createWorkspaceStore();
    let called = false;

    const client = createMockClient({
      createConversation: async () => {
        called = true;
        return {
          id: 'new-conv',
          title: undefined,
          status: 'active' as const,
          createdAt: '2026-04-01T00:00:00.000Z',
          updatedAt: '2026-04-01T00:00:00.000Z',
          turnCount: 0,
          pendingInstructionCount: 0,
        };
      },
    });

    const result = await createAndSubmitDraft({ store, client }, '   ');
    assert.equal(called, false);
    assert.equal(result.ok, false);
  });

  it('throws when createConversation fails', async () => {
    const store = createWorkspaceStore();

    const client = createMockClient({
      createConversation: async () => {
        throw new Error('Gateway 503: Service Unavailable');
      },
    });

    await assert.rejects(() => createAndSubmitDraft({ store, client }, 'hello'), {
      message: 'Gateway 503: Service Unavailable',
    });

    assert.equal(store.getState().activeConversationId, null);
  });

  it('records submit error in draft when submit fails after create', async () => {
    const store = createWorkspaceStore();

    const client = createMockClient({
      createConversation: async () => ({
        id: 'new-conv',
        title: undefined,
        status: 'active' as const,
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:00:00.000Z',
        turnCount: 0,
        pendingInstructionCount: 0,
      }),
      submitInstruction: async () => {
        throw new Error('Rate limited');
      },
    });

    const result = await createAndSubmitDraft({ store, client }, 'first message');

    // Conversation was created and selected, but submit failed
    assert.equal(store.getState().activeConversationId, 'new-conv');
    assert.equal(store.getState().drafts.get('new-conv')?.submitState, 'error');
    assert.equal(store.getState().drafts.get('new-conv')?.validationMessage, 'Rate limited');
    // Draft text should be preserved on error
    assert.equal(store.getState().drafts.get('new-conv')?.draftText, 'first message');
    assert.equal(result.ok, false);
  });

  it('trims whitespace from draft text', async () => {
    const store = createWorkspaceStore();
    const submitted: string[] = [];

    const client = createMockClient({
      submitInstruction: async (_convId, body) => {
        submitted.push(body.instruction);
        return {
          turn: {
            id: 'turn-1',
            conversationId: 'new-conv',
            position: 1,
            kind: 'operator' as const,
            attribution: { type: 'operator' as const, label: 'Operator' },
            instruction: body.instruction,
            status: 'submitted' as const,
            createdAt: '2026-04-01T00:00:00.000Z',
          },
          streamId: 'stream-1',
        };
      },
    });

    await createAndSubmitDraft({ store, client }, '  trimmed  ');

    assert.deepStrictEqual(submitted, ['trimmed']);
  });
});

// ─── submitComposerDraft transcript refresh ─────────────────────────────────

describe('submitComposerDraft transcript refresh', () => {
  it('resets conversation loadState to idle after successful submit', async () => {
    const store = storeWithActiveDraft('conv-1', 'hello agent');
    store.dispatch({
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [createEntry()],
      hasMoreHistory: false,
    });
    assert.equal(store.getState().conversations.get('conv-1')?.loadState, 'ready');

    const client = createMockClient();
    await submitComposerDraft({ store, client });

    assert.equal(store.getState().conversations.get('conv-1')?.loadState, 'idle');
  });

  it('does not reset loadState when submit fails', async () => {
    const store = storeWithActiveDraft('conv-1', 'will fail');
    store.dispatch({
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [createEntry()],
      hasMoreHistory: false,
    });
    assert.equal(store.getState().conversations.get('conv-1')?.loadState, 'ready');

    const client = createMockClient({
      submitInstruction: async () => {
        throw new Error('Gateway down');
      },
    });
    await submitComposerDraft({ store, client });

    assert.equal(store.getState().conversations.get('conv-1')?.loadState, 'ready');
  });
});

// ─── SubmitResult regression: callers must distinguish success from failure ──

describe('SubmitResult regression', () => {
  it('submitComposerDraft returns ok:true on success', async () => {
    const store = storeWithActiveDraft('conv-1', 'go');
    const client = createMockClient();
    const result: SubmitResult = await submitComposerDraft({ store, client });
    assert.equal(result.ok, true);
  });

  it('submitComposerDraft returns ok:false on submit error', async () => {
    const store = storeWithActiveDraft('conv-1', 'fail');
    const client = createMockClient({
      submitInstruction: async () => {
        throw new Error('boom');
      },
    });
    const result: SubmitResult = await submitComposerDraft({ store, client });
    assert.equal(result.ok, false);
  });

  it('createAndSubmitDraft returns ok:false when create succeeds but submit fails', async () => {
    const store = createWorkspaceStore();
    const client = createMockClient({
      createConversation: async () => ({
        id: 'new-conv',
        title: undefined,
        status: 'active' as const,
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:00:00.000Z',
        turnCount: 0,
        pendingInstructionCount: 0,
      }),
      submitInstruction: async () => {
        throw new Error('submit failed after create');
      },
    });

    const result: SubmitResult = await createAndSubmitDraft({ store, client }, 'hello');

    assert.equal(result.ok, false);
    // Conversation was created and selected despite submit failure
    assert.equal(store.getState().activeConversationId, 'new-conv');
    assert.equal(store.getState().drafts.get('new-conv')?.submitState, 'error');
    assert.equal(store.getState().drafts.get('new-conv')?.draftText, 'hello');
  });

  it('create-succeeds-submit-fails must not signal success to callers', async () => {
    // Simulates the sidebar scenario: list load had an error, then user creates
    // a new conversation but instruction submit fails. The caller should NOT
    // clear the sidebar error or reload the list as if everything succeeded.
    const store = createWorkspaceStore();
    let sidebarErrorCleared = false;
    let sidebarReloaded = false;
    let transcriptRefreshed = false;

    const client = createMockClient({
      createConversation: async () => ({
        id: 'new-conv',
        title: undefined,
        status: 'active' as const,
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:00:00.000Z',
        turnCount: 0,
        pendingInstructionCount: 0,
      }),
      submitInstruction: async () => {
        throw new Error('Rate limited');
      },
    });

    const result = await createAndSubmitDraft({ store, client }, 'first message');

    // Simulate what the route handler should do: only clear/reload on ok
    if (result.ok) {
      sidebarErrorCleared = true;
      sidebarReloaded = true;
      transcriptRefreshed = true;
    }

    assert.equal(sidebarErrorCleared, false, 'sidebar error must not be cleared on submit failure');
    assert.equal(sidebarReloaded, false, 'sidebar must not be reloaded on submit failure');
    assert.equal(transcriptRefreshed, false, 'transcript must not be refreshed on submit failure');
  });
});

// ─── submitComposerDraft appends response turn to transcript ────────────────

describe('submitComposerDraft appends response turn', () => {
  it('appends the operator turn from the submit response to transcript entries', async () => {
    const store = storeWithActiveDraft('conv-1', 'hello agent');
    const client = createMockClient({
      submitInstruction: async (convId, body) => ({
        turn: {
          id: 'turn-submitted',
          conversationId: convId,
          position: 2,
          kind: 'operator' as const,
          attribution: { type: 'operator' as const, label: 'Operator' },
          instruction: body.instruction,
          status: 'submitted' as const,
          createdAt: '2026-04-01T00:00:01.000Z',
        },
        streamId: 'stream-submitted',
      }),
    });

    await submitComposerDraft({ store, client });

    const conv = store.getState().conversations.get('conv-1');
    assert.ok(conv, 'conversation must exist');
    const turnEntry = conv.entries.find((e) => e.turnId === 'turn-submitted');
    assert.ok(turnEntry, 'submitted turn must appear in transcript entries');
    assert.equal(turnEntry.kind, 'turn');
    assert.equal(turnEntry.status, 'submitted');
    assert.equal(turnEntry.contentBlocks.length, 1);
    assert.equal(turnEntry.contentBlocks[0].text, 'hello agent');
  });

  it('appends the turn even when historyLoaded is already true', async () => {
    const store = storeWithActiveDraft('conv-1', 'after history');

    // Simulate history already loaded (merge-history sets historyLoaded: true)
    store.dispatch({
      type: 'conversation/merge-history',
      conversationId: 'conv-1',
      entries: [createEntry({ entryId: 'turn-old', turnId: 'turn-old' })],
      hasMoreHistory: false,
    });
    assert.equal(
      store.getState().conversations.get('conv-1')?.historyLoaded,
      true,
      'precondition: historyLoaded must be true',
    );

    const client = createMockClient({
      submitInstruction: async (convId, body) => ({
        turn: {
          id: 'turn-new',
          conversationId: convId,
          position: 2,
          kind: 'operator' as const,
          attribution: { type: 'operator' as const, label: 'Operator' },
          instruction: body.instruction,
          status: 'submitted' as const,
          createdAt: '2026-04-01T00:00:02.000Z',
        },
        streamId: 'stream-new',
      }),
    });

    await submitComposerDraft({ store, client });

    const conv = store.getState().conversations.get('conv-1');
    assert.ok(conv, 'conversation must exist');
    assert.equal(conv.entries.length, 2, 'must have both old + newly submitted entry');
    assert.equal(conv.entries[0].turnId, 'turn-old');
    assert.equal(conv.entries[1].turnId, 'turn-new');
    // historyLoaded must remain true — no re-fetch needed
    assert.equal(conv.historyLoaded, true);
  });

  it('does not duplicate turn if already present in entries', async () => {
    const store = storeWithActiveDraft('conv-1', 'duplicate test');

    // Pre-populate an entry with the same turnId the response will return
    store.dispatch({
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [createEntry({ entryId: 'turn-dup', turnId: 'turn-dup', status: 'submitted' })],
      hasMoreHistory: false,
    });

    const client = createMockClient({
      submitInstruction: async (convId, body) => ({
        turn: {
          id: 'turn-dup',
          conversationId: convId,
          position: 1,
          kind: 'operator' as const,
          attribution: { type: 'operator' as const, label: 'Operator' },
          instruction: body.instruction,
          status: 'submitted' as const,
          createdAt: '2026-04-01T00:00:00.000Z',
        },
        streamId: 'stream-dup',
      }),
    });

    await submitComposerDraft({ store, client });

    const conv = store.getState().conversations.get('conv-1');
    assert.ok(conv, 'conversation must exist');
    assert.equal(conv.entries.length, 1, 'must not duplicate the turn');
  });

  it('appends turn in create-and-submit flow', async () => {
    const store = createWorkspaceStore();
    const client = createMockClient({
      createConversation: async () => ({
        id: 'new-conv',
        title: undefined,
        status: 'active' as const,
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:00:00.000Z',
        turnCount: 0,
        pendingInstructionCount: 0,
      }),
      submitInstruction: async (convId, body) => ({
        turn: {
          id: 'turn-create',
          conversationId: convId,
          position: 1,
          kind: 'operator' as const,
          attribution: { type: 'operator' as const, label: 'Operator' },
          instruction: body.instruction,
          status: 'submitted' as const,
          createdAt: '2026-04-01T00:00:00.000Z',
        },
        streamId: 'stream-create',
      }),
    });

    const result = await createAndSubmitDraft({ store, client }, 'first message');

    assert.equal(result.ok, true);
    const conv = store.getState().conversations.get('new-conv');
    assert.ok(conv, 'new conversation must exist');
    const turnEntry = conv.entries.find((e) => e.turnId === 'turn-create');
    assert.ok(turnEntry, 'submitted turn must appear in new conversation');
    assert.equal(turnEntry.contentBlocks[0].text, 'first message');
  });

  it('does not append turn when submit fails', async () => {
    const store = storeWithActiveDraft('conv-1', 'will fail');
    const client = createMockClient({
      submitInstruction: async () => {
        throw new Error('Gateway down');
      },
    });

    await submitComposerDraft({ store, client });

    const conv = store.getState().conversations.get('conv-1');
    assert.ok(conv, 'conversation must exist');
    assert.equal(conv.entries.length, 0, 'no turn appended on failure');
  });
});

// ─── Reducer: conversation/append-submit-turn ───────────────────────────────

describe('conversation/append-submit-turn reducer', () => {
  it('appends an entry to an existing conversation', () => {
    let state = createInitialWorkspaceState();
    state = reduceWorkspaceState(state, {
      type: 'conversation/upsert',
      conversation: createConversation(),
    });

    const entry = createEntry({ entryId: 'turn-appended', turnId: 'turn-appended' });
    state = reduceWorkspaceState(state, {
      type: 'conversation/append-submit-turn',
      conversationId: 'conv-1',
      entry,
    });

    const conv = state.conversations.get('conv-1');
    assert.ok(conv);
    assert.equal(conv.entries.length, 1);
    assert.equal(conv.entries[0].turnId, 'turn-appended');
  });

  it('skips append when turnId already present in entries', () => {
    let state = createInitialWorkspaceState();
    state = reduceWorkspaceState(state, {
      type: 'conversation/upsert',
      conversation: createConversation(),
    });
    const entry = createEntry({ entryId: 'turn-x', turnId: 'turn-x' });
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [entry],
      hasMoreHistory: false,
    });

    // Attempt to append duplicate
    state = reduceWorkspaceState(state, {
      type: 'conversation/append-submit-turn',
      conversationId: 'conv-1',
      entry: createEntry({ entryId: 'turn-x', turnId: 'turn-x', status: 'executing' }),
    });

    const conv = state.conversations.get('conv-1');
    assert.ok(conv);
    assert.equal(conv.entries.length, 1, 'no duplicate');
    assert.equal(conv.entries[0].status, 'completed', 'original entry unchanged');
  });

  it('does not modify historyLoaded flag', () => {
    let state = createInitialWorkspaceState();
    state = reduceWorkspaceState(state, {
      type: 'conversation/upsert',
      conversation: createConversation(),
    });
    // Set historyLoaded via merge-history
    state = reduceWorkspaceState(state, {
      type: 'conversation/merge-history',
      conversationId: 'conv-1',
      entries: [],
      hasMoreHistory: false,
    });
    assert.equal(state.conversations.get('conv-1')?.historyLoaded, true);

    state = reduceWorkspaceState(state, {
      type: 'conversation/append-submit-turn',
      conversationId: 'conv-1',
      entry: createEntry({ entryId: 'turn-new', turnId: 'turn-new' }),
    });

    assert.equal(state.conversations.get('conv-1')?.historyLoaded, true);
    assert.equal(state.conversations.get('conv-1')?.entries.length, 1);
  });
});

// ─── conversation/update-control-state ──────────────────────────────────────

describe('conversation/update-control-state', () => {
  it('patches canSubmit on the target conversation', () => {
    let state = createInitialWorkspaceState();
    state = reduceWorkspaceState(state, {
      type: 'conversation/select',
      conversationId: 'conv-1',
    });

    const before = state.conversations.get('conv-1');
    assert.equal(before?.controlState.canSubmit, true);

    state = reduceWorkspaceState(state, {
      type: 'conversation/update-control-state',
      conversationId: 'conv-1',
      patch: { canSubmit: false },
    });

    const after = state.conversations.get('conv-1');
    assert.equal(after?.controlState.canSubmit, false);
    // Other fields unchanged
    assert.equal(after?.controlState.staleReason, null);
  });

  it('patches staleReason while preserving other fields', () => {
    let state = createInitialWorkspaceState();
    state = reduceWorkspaceState(state, {
      type: 'conversation/select',
      conversationId: 'conv-1',
    });
    state = reduceWorkspaceState(state, {
      type: 'conversation/update-control-state',
      conversationId: 'conv-1',
      patch: { staleReason: 'Session expired', canSubmit: false },
    });

    const conv = state.conversations.get('conv-1');
    assert.equal(conv?.controlState.staleReason, 'Session expired');
    assert.equal(conv?.controlState.canSubmit, false);
    assert.equal(conv?.controlState.submissionPolicyLabel, 'Ready for operator input');
  });

  it('patches submissionPolicyLabel', () => {
    let state = createInitialWorkspaceState();
    state = reduceWorkspaceState(state, {
      type: 'conversation/select',
      conversationId: 'conv-1',
    });
    state = reduceWorkspaceState(state, {
      type: 'conversation/update-control-state',
      conversationId: 'conv-1',
      patch: { submissionPolicyLabel: 'Agent is busy' },
    });

    assert.equal(
      state.conversations.get('conv-1')?.controlState.submissionPolicyLabel,
      'Agent is busy',
    );
  });

  it('seeds unknown conversations instead of dropping out-of-order patches', () => {
    const state = createInitialWorkspaceState();
    const next = reduceWorkspaceState(state, {
      type: 'conversation/update-control-state',
      conversationId: 'late-arriving',
      patch: { canSubmit: false, staleReason: 'Agent busy' },
    });

    const conv = next.conversations.get('late-arriving');
    assert.ok(conv, 'conversation must be seeded');
    assert.equal(conv.controlState.canSubmit, false);
    assert.equal(conv.controlState.staleReason, 'Agent busy');
    assert.equal(conv.controlState.submissionPolicyLabel, 'Ready for operator input');
  });

  it('clears staleReason back to null', () => {
    let state = createInitialWorkspaceState();
    state = reduceWorkspaceState(state, {
      type: 'conversation/select',
      conversationId: 'conv-1',
    });
    state = reduceWorkspaceState(state, {
      type: 'conversation/update-control-state',
      conversationId: 'conv-1',
      patch: { staleReason: 'Stale' },
    });
    state = reduceWorkspaceState(state, {
      type: 'conversation/update-control-state',
      conversationId: 'conv-1',
      patch: { staleReason: null, canSubmit: true },
    });

    const conv = state.conversations.get('conv-1');
    assert.equal(conv?.controlState.staleReason, null);
    assert.equal(conv?.controlState.canSubmit, true);
  });
});

// ─── entry/update-controls ──────────────────────────────────────────────────

describe('entry/update-controls', () => {
  it('sets controls on a matching entry', () => {
    let state = createInitialWorkspaceState();
    state = reduceWorkspaceState(state, {
      type: 'conversation/select',
      conversationId: 'conv-1',
    });
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [createEntry({ entryId: 'e1', turnId: 'turn-1' })],
      hasMoreHistory: false,
    });

    const controls = [
      { controlId: 'ctrl-1', kind: 'retry' as const, enabled: true, reasonDisabled: null },
      { controlId: 'ctrl-2', kind: 'branch' as const, enabled: false, reasonDisabled: 'Not yet' },
    ];

    state = reduceWorkspaceState(state, {
      type: 'entry/update-controls',
      conversationId: 'conv-1',
      entryId: 'e1',
      controls,
    });

    const entry = state.conversations.get('conv-1')?.entries[0];
    assert.equal(entry?.controls.length, 2);
    assert.equal(entry?.controls[0].kind, 'retry');
    assert.equal(entry?.controls[1].enabled, false);
    assert.equal(entry?.controls[1].reasonDisabled, 'Not yet');
  });

  it('is a no-op when the entry does not exist', () => {
    let state = createInitialWorkspaceState();
    state = reduceWorkspaceState(state, {
      type: 'conversation/select',
      conversationId: 'conv-1',
    });
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [createEntry({ entryId: 'e1', turnId: 'turn-1' })],
      hasMoreHistory: false,
    });

    const before = state;
    state = reduceWorkspaceState(state, {
      type: 'entry/update-controls',
      conversationId: 'conv-1',
      entryId: 'no-such',
      controls: [{ controlId: 'c', kind: 'retry', enabled: true, reasonDisabled: null }],
    });

    assert.equal(state, before);
  });

  it('replaces existing controls entirely', () => {
    let state = createInitialWorkspaceState();
    state = reduceWorkspaceState(state, {
      type: 'conversation/select',
      conversationId: 'conv-1',
    });
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [
        createEntry({
          entryId: 'e1',
          turnId: 'turn-1',
          controls: [{ controlId: 'old-1', kind: 'cancel', enabled: true, reasonDisabled: null }],
        }),
      ],
      hasMoreHistory: false,
    });

    state = reduceWorkspaceState(state, {
      type: 'entry/update-controls',
      conversationId: 'conv-1',
      entryId: 'e1',
      controls: [{ controlId: 'new-1', kind: 'retry', enabled: true, reasonDisabled: null }],
    });

    const entry = state.conversations.get('conv-1')?.entries[0];
    assert.equal(entry?.controls.length, 1);
    assert.equal(entry?.controls[0].controlId, 'new-1');
  });
});

// ─── Lineage always defaults to branch (record-level lineageKind deferred to T035+) ─

describe('lineage relationshipKind from record', () => {
  it('defaults to branch when parentConversationId and forkPointTurnId are present', () => {
    const state = reduceWorkspaceState(createInitialWorkspaceState(), {
      type: 'conversation/upsert',
      conversation: {
        id: 'conv-branch',
        parentConversationId: 'conv-root',
        forkPointTurnId: 'turn-5',
      },
    });
    assert.equal(
      state.conversations.get('conv-branch')?.lineageSummary?.relationshipKind,
      'branch',
    );
  });

  it('returns null lineage when parentConversationId is missing', () => {
    const state = reduceWorkspaceState(createInitialWorkspaceState(), {
      type: 'conversation/upsert',
      conversation: {
        id: 'conv-root',
        forkPointTurnId: 'turn-5',
      },
    });
    assert.equal(state.conversations.get('conv-root')?.lineageSummary, null);
  });
});

// ─── Transcript reconciliation after turn actions ───────────────────────────
// Focused reducer-level tests validating the mechanisms used by handleCancel
// and handleRetry for immediate transcript reconciliation (T035/T036).

describe('transcript reconciliation after turn actions', () => {
  it('replace-entries updates a cancelled turn status in-place', () => {
    let state = createInitialWorkspaceState();
    state = reduceWorkspaceState(state, {
      type: 'conversation/upsert',
      conversation: createConversation(),
    });
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [
        createEntry({ entryId: 'e1', turnId: 'turn-1', status: 'streaming' }),
        createEntry({ entryId: 'e2', turnId: 'turn-2', status: 'completed' }),
      ],
      hasMoreHistory: false,
    });

    // Simulate the reconcileTurnEntry helper: replace streaming → cancelled
    const conv = state.conversations.get('conv-1');
    assert.ok(conv);
    const patched = conv.entries.map((e) =>
      e.turnId === 'turn-1' ? { ...e, status: 'cancelled' } : e,
    );
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: patched,
      hasMoreHistory: false,
    });

    const updated = state.conversations.get('conv-1');
    assert.equal(updated?.entries[0]?.status, 'cancelled');
    assert.equal(updated?.entries[1]?.status, 'completed');
    assert.equal(updated?.entries.length, 2);
  });

  it('replace-entries appends a new retry turn entry', () => {
    let state = createInitialWorkspaceState();
    state = reduceWorkspaceState(state, {
      type: 'conversation/upsert',
      conversation: createConversation(),
    });
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [createEntry({ entryId: 'e1', turnId: 'turn-1', status: 'failed' })],
      hasMoreHistory: false,
    });

    // Simulate the reconcileTurnEntry helper: append new retry turn
    const conv = state.conversations.get('conv-1');
    assert.ok(conv);
    const retryEntry = createEntry({ entryId: 'e2', turnId: 'turn-2', status: 'submitted' });
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [...conv.entries, retryEntry],
      hasMoreHistory: false,
    });

    const updated = state.conversations.get('conv-1');
    assert.equal(updated?.entries.length, 2);
    assert.equal(updated?.entries[0]?.status, 'failed');
    assert.equal(updated?.entries[1]?.status, 'submitted');
  });

  it('merge-history reconciles a full transcript after cancel', () => {
    let state = createInitialWorkspaceState();
    state = reduceWorkspaceState(state, {
      type: 'conversation/upsert',
      conversation: createConversation(),
    });
    // Stream has an in-flight turn
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [createEntry({ entryId: 'turn-1', turnId: 'turn-1', status: 'streaming' })],
      hasMoreHistory: false,
    });

    // Full authoritative reload shows the turn as cancelled
    state = reduceWorkspaceState(state, {
      type: 'conversation/merge-history',
      conversationId: 'conv-1',
      entries: [createEntry({ entryId: 'turn-1', turnId: 'turn-1', status: 'cancelled' })],
      hasMoreHistory: false,
    });

    const conv = state.conversations.get('conv-1');
    assert.equal(conv?.entries.length, 1);
    assert.equal(conv?.entries[0]?.status, 'cancelled');
    assert.equal(conv?.loadState, 'ready');
    assert.equal(conv?.historyLoaded, true);
  });

  it('control-state restore preserves previous state on failure', () => {
    let state = createInitialWorkspaceState();
    state = reduceWorkspaceState(state, {
      type: 'conversation/select',
      conversationId: 'conv-1',
    });
    // Set a non-default state
    state = reduceWorkspaceState(state, {
      type: 'conversation/update-control-state',
      conversationId: 'conv-1',
      patch: { canSubmit: true, submissionPolicyLabel: 'Agent idle', staleReason: null },
    });

    const prevControlState = state.conversations.get('conv-1')?.controlState;
    assert.ok(prevControlState);

    // Simulate locking during action
    state = reduceWorkspaceState(state, {
      type: 'conversation/update-control-state',
      conversationId: 'conv-1',
      patch: { canSubmit: false, submissionPolicyLabel: 'Cancelling…' },
    });
    assert.equal(state.conversations.get('conv-1')?.controlState.canSubmit, false);

    // Simulate failure: restore previous state
    state = reduceWorkspaceState(state, {
      type: 'conversation/update-control-state',
      conversationId: 'conv-1',
      patch: prevControlState,
    });

    assert.equal(state.conversations.get('conv-1')?.controlState.canSubmit, true);
    assert.equal(
      state.conversations.get('conv-1')?.controlState.submissionPolicyLabel,
      'Agent idle',
    );
  });

  it('merge-history after retry appends new turn and preserves existing entries', () => {
    let state = createInitialWorkspaceState();
    state = reduceWorkspaceState(state, {
      type: 'conversation/upsert',
      conversation: createConversation(),
    });
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [createEntry({ entryId: 'turn-1', turnId: 'turn-1', status: 'failed' })],
      hasMoreHistory: false,
    });

    // Full reload after retry contains both original (failed) and new retry turn
    state = reduceWorkspaceState(state, {
      type: 'conversation/merge-history',
      conversationId: 'conv-1',
      entries: [
        createEntry({ entryId: 'turn-1', turnId: 'turn-1', status: 'failed' }),
        createEntry({ entryId: 'turn-2', turnId: 'turn-2', status: 'submitted' }),
      ],
      hasMoreHistory: false,
    });

    const conv = state.conversations.get('conv-1');
    assert.equal(conv?.entries.length, 2);
    assert.equal(conv?.entries[0]?.status, 'failed');
    assert.equal(conv?.entries[1]?.status, 'submitted');
  });
});

// ─── invalidateStaleEntryControls (unit) ────────────────────────────────────

describe('invalidateStaleEntryControls', () => {
  it('disables enabled controls when entry status diverged', () => {
    const preMerge = [
      createEntry({
        entryId: 'turn-1',
        turnId: 'turn-1',
        status: 'streaming',
        controls: [
          { controlId: 'ctrl-cancel', kind: 'cancel', enabled: true, reasonDisabled: null },
        ],
      }),
    ];
    const postMerge = [
      createEntry({
        entryId: 'turn-1',
        turnId: 'turn-1',
        status: 'completed',
        controls: [
          { controlId: 'ctrl-cancel', kind: 'cancel', enabled: true, reasonDisabled: null },
        ],
      }),
    ];

    const result = invalidateStaleEntryControls(preMerge, postMerge);
    assert.notEqual(result, postMerge, 'should return a new array');
    assert.equal(result[0].controls[0].enabled, false);
    assert.ok(result[0].controls[0].reasonDisabled);
  });

  it('returns same reference when no controls need invalidation', () => {
    const preMerge = [createEntry({ entryId: 'turn-1', turnId: 'turn-1', status: 'completed' })];
    const postMerge = [createEntry({ entryId: 'turn-1', turnId: 'turn-1', status: 'completed' })];

    const result = invalidateStaleEntryControls(preMerge, postMerge);
    assert.equal(result, postMerge);
  });

  it('skips entries without controls', () => {
    const preMerge = [createEntry({ entryId: 'turn-1', turnId: 'turn-1', status: 'streaming' })];
    const postMerge = [createEntry({ entryId: 'turn-1', turnId: 'turn-1', status: 'completed' })];

    const result = invalidateStaleEntryControls(preMerge, postMerge);
    assert.equal(result, postMerge);
  });

  it('preserves already-disabled controls', () => {
    const preMerge = [
      createEntry({
        entryId: 'turn-1',
        turnId: 'turn-1',
        status: 'streaming',
        controls: [
          {
            controlId: 'ctrl-branch',
            kind: 'branch',
            enabled: false,
            reasonDisabled: 'Not available',
          },
        ],
      }),
    ];
    const postMerge = [
      createEntry({
        entryId: 'turn-1',
        turnId: 'turn-1',
        status: 'completed',
        controls: [
          {
            controlId: 'ctrl-branch',
            kind: 'branch',
            enabled: false,
            reasonDisabled: 'Not available',
          },
        ],
      }),
    ];

    const result = invalidateStaleEntryControls(preMerge, postMerge);
    assert.equal(result, postMerge, 'no enabled controls to invalidate');
    assert.equal(result[0].controls[0].reasonDisabled, 'Not available');
  });

  it('skips entries whose status did not change', () => {
    const preMerge = [
      createEntry({
        entryId: 'turn-1',
        turnId: 'turn-1',
        status: 'completed',
        controls: [{ controlId: 'ctrl-retry', kind: 'retry', enabled: true, reasonDisabled: null }],
      }),
    ];
    const postMerge = [
      createEntry({
        entryId: 'turn-1',
        turnId: 'turn-1',
        status: 'completed',
        controls: [{ controlId: 'ctrl-retry', kind: 'retry', enabled: true, reasonDisabled: null }],
      }),
    ];

    const result = invalidateStaleEntryControls(preMerge, postMerge);
    assert.equal(result, postMerge);
    assert.equal(result[0].controls[0].enabled, true);
  });

  it('skips entries only present in the post-merge set (new from REST)', () => {
    const preMerge: TranscriptEntryState[] = [];
    const postMerge = [
      createEntry({
        entryId: 'turn-1',
        turnId: 'turn-1',
        status: 'completed',
        controls: [{ controlId: 'ctrl-retry', kind: 'retry', enabled: true, reasonDisabled: null }],
      }),
    ];

    const result = invalidateStaleEntryControls(preMerge, postMerge);
    assert.equal(result, postMerge);
  });

  it('invalidates only the entries whose status changed in a mixed batch', () => {
    const preMerge = [
      createEntry({
        entryId: 'turn-1',
        turnId: 'turn-1',
        status: 'streaming',
        controls: [{ controlId: 'c1', kind: 'cancel', enabled: true, reasonDisabled: null }],
      }),
      createEntry({
        entryId: 'turn-2',
        turnId: 'turn-2',
        status: 'completed',
        controls: [{ controlId: 'c2', kind: 'retry', enabled: true, reasonDisabled: null }],
      }),
    ];
    const postMerge = [
      createEntry({
        entryId: 'turn-1',
        turnId: 'turn-1',
        status: 'completed',
        controls: [{ controlId: 'c1', kind: 'cancel', enabled: true, reasonDisabled: null }],
      }),
      createEntry({
        entryId: 'turn-2',
        turnId: 'turn-2',
        status: 'completed',
        controls: [{ controlId: 'c2', kind: 'retry', enabled: true, reasonDisabled: null }],
      }),
    ];

    const result = invalidateStaleEntryControls(preMerge, postMerge);
    assert.notEqual(result, postMerge);
    // turn-1: status changed → controls invalidated
    assert.equal(result[0].controls[0].enabled, false);
    // turn-2: status unchanged → controls preserved
    assert.equal(result[1].controls[0].enabled, true);
  });
});

// ─── Multi-session convergence — merge-history stale-control invalidation ───

describe('multi-session convergence — merge-history invalidation', () => {
  it('invalidates entry controls when authoritative merge changes entry status', () => {
    let state = createInitialWorkspaceState();
    state = reduceWorkspaceState(state, {
      type: 'conversation/upsert',
      conversation: createConversation(),
    });
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [
        createEntry({
          entryId: 'turn-1',
          turnId: 'turn-1',
          status: 'streaming',
          controls: [
            { controlId: 'ctrl-cancel', kind: 'cancel', enabled: true, reasonDisabled: null },
          ],
        }),
      ],
      hasMoreHistory: false,
    });

    // Authoritative merge: another session completed the turn
    state = reduceWorkspaceState(state, {
      type: 'conversation/merge-history',
      conversationId: 'conv-1',
      entries: [createEntry({ entryId: 'turn-1', turnId: 'turn-1', status: 'completed' })],
      hasMoreHistory: false,
    });

    const entry = state.conversations.get('conv-1')?.entries[0];
    assert.ok(entry);
    assert.equal(entry.controls.length, 1);
    assert.equal(entry.controls[0].enabled, false);
    assert.ok(entry.controls[0].reasonDisabled, 'must provide a reason');
  });

  it('sets conversation staleReason when controls are invalidated by merge', () => {
    let state = createInitialWorkspaceState();
    state = reduceWorkspaceState(state, {
      type: 'conversation/select',
      conversationId: 'conv-1',
    });
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [
        createEntry({
          entryId: 'turn-1',
          turnId: 'turn-1',
          status: 'streaming',
          controls: [
            { controlId: 'ctrl-cancel', kind: 'cancel', enabled: true, reasonDisabled: null },
          ],
        }),
      ],
      hasMoreHistory: false,
    });

    state = reduceWorkspaceState(state, {
      type: 'conversation/merge-history',
      conversationId: 'conv-1',
      entries: [createEntry({ entryId: 'turn-1', turnId: 'turn-1', status: 'completed' })],
      hasMoreHistory: false,
    });

    const conv = state.conversations.get('conv-1');
    assert.ok(conv?.controlState.staleReason, 'must set a stale reason');
  });

  it('does not invalidate controls when authoritative status matches local', () => {
    let state = createInitialWorkspaceState();
    state = reduceWorkspaceState(state, {
      type: 'conversation/upsert',
      conversation: createConversation(),
    });
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [
        createEntry({
          entryId: 'turn-1',
          turnId: 'turn-1',
          status: 'completed',
          controls: [
            { controlId: 'ctrl-retry', kind: 'retry', enabled: true, reasonDisabled: null },
          ],
        }),
      ],
      hasMoreHistory: false,
    });

    state = reduceWorkspaceState(state, {
      type: 'conversation/merge-history',
      conversationId: 'conv-1',
      entries: [createEntry({ entryId: 'turn-1', turnId: 'turn-1', status: 'completed' })],
      hasMoreHistory: false,
    });

    const entry = state.conversations.get('conv-1')?.entries[0];
    assert.ok(entry);
    assert.equal(entry.controls[0].enabled, true);
    assert.equal(entry.controls[0].reasonDisabled, null);
  });

  it('does not set staleReason when no controls are invalidated', () => {
    let state = createInitialWorkspaceState();
    state = reduceWorkspaceState(state, {
      type: 'conversation/select',
      conversationId: 'conv-1',
    });
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [createEntry({ entryId: 'turn-1', turnId: 'turn-1', status: 'completed' })],
      hasMoreHistory: false,
    });

    state = reduceWorkspaceState(state, {
      type: 'conversation/merge-history',
      conversationId: 'conv-1',
      entries: [createEntry({ entryId: 'turn-1', turnId: 'turn-1', status: 'completed' })],
      hasMoreHistory: false,
    });

    assert.equal(state.conversations.get('conv-1')?.controlState.staleReason, null);
  });

  it('preserves already-disabled controls during invalidation', () => {
    let state = createInitialWorkspaceState();
    state = reduceWorkspaceState(state, {
      type: 'conversation/upsert',
      conversation: createConversation(),
    });
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [
        createEntry({
          entryId: 'turn-1',
          turnId: 'turn-1',
          status: 'streaming',
          controls: [
            {
              controlId: 'ctrl-branch',
              kind: 'branch',
              enabled: false,
              reasonDisabled: 'Not available yet',
            },
          ],
        }),
      ],
      hasMoreHistory: false,
    });

    state = reduceWorkspaceState(state, {
      type: 'conversation/merge-history',
      conversationId: 'conv-1',
      entries: [createEntry({ entryId: 'turn-1', turnId: 'turn-1', status: 'completed' })],
      hasMoreHistory: false,
    });

    const entry = state.conversations.get('conv-1')?.entries[0];
    assert.ok(entry);
    assert.equal(entry.controls[0].enabled, false);
    assert.equal(entry.controls[0].reasonDisabled, 'Not available yet');
  });

  it('invalidates only changed entries in a multi-entry merge', () => {
    let state = createInitialWorkspaceState();
    state = reduceWorkspaceState(state, {
      type: 'conversation/upsert',
      conversation: createConversation(),
    });
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [
        createEntry({
          entryId: 'turn-1',
          turnId: 'turn-1',
          status: 'streaming',
          controls: [{ controlId: 'c1', kind: 'cancel', enabled: true, reasonDisabled: null }],
        }),
        createEntry({
          entryId: 'turn-2',
          turnId: 'turn-2',
          status: 'completed',
          controls: [{ controlId: 'c2', kind: 'retry', enabled: true, reasonDisabled: null }],
        }),
      ],
      hasMoreHistory: false,
    });

    state = reduceWorkspaceState(state, {
      type: 'conversation/merge-history',
      conversationId: 'conv-1',
      entries: [
        createEntry({ entryId: 'turn-1', turnId: 'turn-1', status: 'completed' }),
        createEntry({ entryId: 'turn-2', turnId: 'turn-2', status: 'completed' }),
      ],
      hasMoreHistory: false,
    });

    const entries = state.conversations.get('conv-1')?.entries;
    assert.ok(entries);
    // turn-1: status changed streaming→completed, controls invalidated
    assert.equal(entries[0].controls[0].enabled, false);
    // turn-2: status unchanged, controls preserved
    assert.equal(entries[1].controls[0].enabled, true);
  });
});

// ─── Multi-session convergence & stale-control invalidation ─────────────────

describe('multi-session convergence: stale-control invalidation', () => {
  it('disables entry cancel control when authoritative merge shows turn cancelled externally', () => {
    let state = createInitialWorkspaceState();
    state = reduceWorkspaceState(state, {
      type: 'conversation/upsert',
      conversation: createConversation(),
    });
    // Local session: turn is streaming with cancel enabled
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [
        createEntry({
          entryId: 'turn-1',
          turnId: 'turn-1',
          status: 'streaming',
          controls: [
            { controlId: 'ctrl-cancel', kind: 'cancel', enabled: true, reasonDisabled: null },
          ],
        }),
      ],
      hasMoreHistory: false,
    });

    // Another session cancelled the turn — authoritative merge arrives
    state = reduceWorkspaceState(state, {
      type: 'conversation/merge-history',
      conversationId: 'conv-1',
      entries: [
        createEntry({
          entryId: 'turn-1',
          turnId: 'turn-1',
          status: 'cancelled',
          controls: [],
        }),
      ],
      hasMoreHistory: false,
    });

    const conv = state.conversations.get('conv-1');
    const turn = conv?.entries[0];
    assert.equal(turn?.status, 'cancelled');
    // Cancel control must be present but disabled with an explicit reason
    const cancelCtrl = turn?.controls.find((c) => c.kind === 'cancel');
    assert.ok(cancelCtrl, 'cancel control must still be present (disabled, not silently stripped)');
    assert.equal(cancelCtrl?.enabled, false);
    assert.ok(
      cancelCtrl?.reasonDisabled != null && cancelCtrl.reasonDisabled.length > 0,
      'reasonDisabled must explain why control is stale',
    );
  });

  it('sets conversation controlState.staleReason when merge actually invalidates controls', () => {
    let state = createInitialWorkspaceState();
    state = reduceWorkspaceState(state, {
      type: 'conversation/upsert',
      conversation: createConversation(),
    });
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [
        createEntry({
          entryId: 'turn-1',
          turnId: 'turn-1',
          status: 'streaming',
          controls: [
            { controlId: 'ctrl-cancel', kind: 'cancel', enabled: true, reasonDisabled: null },
          ],
        }),
      ],
      hasMoreHistory: false,
    });

    // Authoritative merge shows turn completed by another session — controls get invalidated
    state = reduceWorkspaceState(state, {
      type: 'conversation/merge-history',
      conversationId: 'conv-1',
      entries: [createEntry({ entryId: 'turn-1', turnId: 'turn-1', status: 'completed' })],
      hasMoreHistory: false,
    });

    const conv = state.conversations.get('conv-1');
    assert.ok(
      conv?.controlState.staleReason != null,
      'staleReason must indicate external state change',
    );
  });

  it('does not set staleReason when drift exists but no controls were actually invalidated', () => {
    let state = createInitialWorkspaceState();
    state = reduceWorkspaceState(state, {
      type: 'conversation/upsert',
      conversation: createConversation(),
    });
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [createEntry({ entryId: 'turn-1', turnId: 'turn-1', status: 'streaming' })],
      hasMoreHistory: false,
    });

    // Authoritative merge shows turn completed — drift exists but no controls to invalidate
    state = reduceWorkspaceState(state, {
      type: 'conversation/merge-history',
      conversationId: 'conv-1',
      entries: [createEntry({ entryId: 'turn-1', turnId: 'turn-1', status: 'completed' })],
      hasMoreHistory: false,
    });

    const conv = state.conversations.get('conv-1');
    assert.equal(
      conv?.controlState.staleReason,
      null,
      'staleReason must be null when no controls were actually invalidated',
    );
  });

  it('does not set staleReason when convergence only preserves already-disabled controls', () => {
    let state = createInitialWorkspaceState();
    state = reduceWorkspaceState(state, {
      type: 'conversation/upsert',
      conversation: createConversation(),
    });
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [
        createEntry({
          entryId: 'turn-1',
          turnId: 'turn-1',
          status: 'streaming',
          controls: [
            {
              controlId: 'ctrl-cancel',
              kind: 'cancel',
              enabled: false,
              reasonDisabled: 'Already stopping',
            },
          ],
        }),
      ],
      hasMoreHistory: false,
    });

    state = reduceWorkspaceState(state, {
      type: 'conversation/merge-history',
      conversationId: 'conv-1',
      entries: [createEntry({ entryId: 'turn-1', turnId: 'turn-1', status: 'completed' })],
      hasMoreHistory: false,
    });

    const conv = state.conversations.get('conv-1');
    assert.equal(
      conv?.controlState.staleReason,
      null,
      'already-disabled controls should be preserved without marking the conversation stale',
    );
  });

  it('does not set staleReason when merge produces no external status changes', () => {
    let state = createInitialWorkspaceState();
    state = reduceWorkspaceState(state, {
      type: 'conversation/upsert',
      conversation: createConversation(),
    });
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [createEntry({ entryId: 'turn-1', turnId: 'turn-1', status: 'completed' })],
      hasMoreHistory: false,
    });

    // Same authoritative state — no drift
    state = reduceWorkspaceState(state, {
      type: 'conversation/merge-history',
      conversationId: 'conv-1',
      entries: [createEntry({ entryId: 'turn-1', turnId: 'turn-1', status: 'completed' })],
      hasMoreHistory: false,
    });

    const conv = state.conversations.get('conv-1');
    assert.equal(conv?.controlState.staleReason, null);
  });

  it('does not mark the conversation stale for ordinary non-terminal progress', () => {
    let state = createInitialWorkspaceState();
    state = reduceWorkspaceState(state, {
      type: 'conversation/upsert',
      conversation: createConversation(),
    });
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [
        createEntry({ entryId: 'turn-running', turnId: 'turn-running', status: 'submitted' }),
        createEntry({ entryId: 'turn-old', turnId: 'turn-old', status: 'completed' }),
      ],
      hasMoreHistory: false,
    });

    state = reduceWorkspaceState(state, {
      type: 'conversation/merge-history',
      conversationId: 'conv-1',
      entries: [
        createEntry({ entryId: 'turn-running', turnId: 'turn-running', status: 'executing' }),
        createEntry({ entryId: 'turn-old', turnId: 'turn-old', status: 'completed' }),
      ],
      hasMoreHistory: false,
    });

    const conv = state.conversations.get('conv-1');
    assert.equal(conv?.controlState.staleReason, null);
  });

  it('disables enabled retry/branch controls on turns that became terminal externally', () => {
    let state = createInitialWorkspaceState();
    state = reduceWorkspaceState(state, {
      type: 'conversation/upsert',
      conversation: createConversation(),
    });
    // Local session thinks turn is still running with action controls
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [
        createEntry({
          entryId: 'turn-1',
          turnId: 'turn-1',
          status: 'streaming',
          controls: [
            { controlId: 'c-cancel', kind: 'cancel', enabled: true, reasonDisabled: null },
            { controlId: 'c-retry', kind: 'retry', enabled: true, reasonDisabled: null },
          ],
        }),
      ],
      hasMoreHistory: false,
    });

    // Authoritative merge: turn failed externally, REST provides fresh controls
    state = reduceWorkspaceState(state, {
      type: 'conversation/merge-history',
      conversationId: 'conv-1',
      entries: [
        createEntry({
          entryId: 'turn-1',
          turnId: 'turn-1',
          status: 'failed',
          controls: [
            { controlId: 'c-retry-rest', kind: 'retry', enabled: true, reasonDisabled: null },
          ],
        }),
      ],
      hasMoreHistory: false,
    });

    const conv = state.conversations.get('conv-1');
    const turn = conv?.entries[0];
    assert.equal(turn?.status, 'failed');
    // Cancel should be disabled (turn is terminal)
    const cancelCtrl = turn?.controls.find((c) => c.kind === 'cancel');
    assert.ok(cancelCtrl, 'cancel control preserved as disabled');
    assert.equal(cancelCtrl?.enabled, false);
    // REST-provided retry should be present
    const retryCtrl = turn?.controls.find((c) => c.kind === 'retry');
    assert.ok(retryCtrl, 'retry control from REST must be present');
  });

  it('marks actionable prompts stale when turn becomes terminal via external merge', () => {
    let state = createInitialWorkspaceState();
    state = reduceWorkspaceState(state, {
      type: 'conversation/upsert',
      conversation: createConversation(),
    });
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [
        createEntry({
          entryId: 'turn-1',
          turnId: 'turn-1',
          status: 'streaming',
          prompt: {
            promptId: 'p1',
            parentTurnId: 'turn-1',
            status: 'pending',
            allowedResponses: [{ key: 'approve', label: 'Approve' }],
            contextBlocks: [],
            lastResponseSummary: null,
            errorMessage: null,
            staleReason: null,
          },
        }),
      ],
      hasMoreHistory: false,
    });

    // Another session resolved the prompt, turn completed
    state = reduceWorkspaceState(state, {
      type: 'conversation/merge-history',
      conversationId: 'conv-1',
      entries: [
        createEntry({ entryId: 'turn-1', turnId: 'turn-1', status: 'completed', prompt: null }),
      ],
      hasMoreHistory: false,
    });

    const conv = state.conversations.get('conv-1');
    const turn = conv?.entries[0];
    // Prompt should be stale (not pending) since turn is terminal
    assert.ok(
      turn?.prompt == null || turn?.prompt?.status === 'stale',
      'prompt must be stale or absent after external terminal merge',
    );
  });

  it('preserves resolved prompt state through convergence merge', () => {
    let state = createInitialWorkspaceState();
    state = reduceWorkspaceState(state, {
      type: 'conversation/upsert',
      conversation: createConversation(),
    });
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [
        createEntry({
          entryId: 'turn-1',
          turnId: 'turn-1',
          status: 'completed',
          prompt: {
            promptId: 'p1',
            parentTurnId: 'turn-1',
            status: 'resolved',
            allowedResponses: [],
            contextBlocks: [],
            lastResponseSummary: 'Approved',
            errorMessage: null,
            staleReason: null,
          },
        }),
      ],
      hasMoreHistory: false,
    });

    // Same terminal state arrives from REST
    state = reduceWorkspaceState(state, {
      type: 'conversation/merge-history',
      conversationId: 'conv-1',
      entries: [
        createEntry({ entryId: 'turn-1', turnId: 'turn-1', status: 'completed', prompt: null }),
      ],
      hasMoreHistory: false,
    });

    const conv = state.conversations.get('conv-1');
    const turn = conv?.entries[0];
    assert.equal(turn?.prompt?.status, 'resolved', 'resolved prompt preserved through convergence');
    assert.equal(turn?.prompt?.lastResponseSummary, 'Approved');
  });

  it('clears staleReason when fresh merge shows no new drift', () => {
    let state = createInitialWorkspaceState();
    state = reduceWorkspaceState(state, {
      type: 'conversation/upsert',
      conversation: createConversation(),
    });
    // First: external change with controls causes staleReason to be set
    state = reduceWorkspaceState(state, {
      type: 'conversation/replace-entries',
      conversationId: 'conv-1',
      entries: [
        createEntry({
          entryId: 'turn-1',
          turnId: 'turn-1',
          status: 'streaming',
          controls: [
            { controlId: 'ctrl-cancel', kind: 'cancel', enabled: true, reasonDisabled: null },
          ],
        }),
      ],
      hasMoreHistory: false,
    });
    state = reduceWorkspaceState(state, {
      type: 'conversation/merge-history',
      conversationId: 'conv-1',
      entries: [createEntry({ entryId: 'turn-1', turnId: 'turn-1', status: 'completed' })],
      hasMoreHistory: false,
    });
    assert.ok(state.conversations.get('conv-1')?.controlState.staleReason != null);

    // Second merge with no new changes — staleReason should be cleared
    state = reduceWorkspaceState(state, {
      type: 'conversation/merge-history',
      conversationId: 'conv-1',
      entries: [createEntry({ entryId: 'turn-1', turnId: 'turn-1', status: 'completed' })],
      hasMoreHistory: false,
    });

    assert.equal(state.conversations.get('conv-1')?.controlState.staleReason, null);
  });
});
