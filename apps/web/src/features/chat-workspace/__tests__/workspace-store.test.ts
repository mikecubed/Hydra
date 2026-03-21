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
