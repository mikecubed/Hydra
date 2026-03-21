import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createInitialWorkspaceState,
  reduceWorkspaceState,
  type ComposerDraftState,
  type WorkspaceState,
} from '../model/workspace-store.ts';

import {
  getDraft,
  getActiveDraft,
  isDraftNonEmpty,
  isDraftSubmittable,
  hasDraftError,
} from '../model/composer-drafts.ts';

// ─── Helpers ────────────────────────────────────────────────────────────────

function stateWithDraft(conversationId: string, draftText: string): WorkspaceState {
  let state = createInitialWorkspaceState();
  state = reduceWorkspaceState(state, {
    type: 'conversation/select',
    conversationId,
  });
  if (draftText !== '') {
    state = reduceWorkspaceState(state, {
      type: 'draft/set-text',
      conversationId,
      draftText,
    });
  }
  return state;
}

function makeDraft(overrides: Partial<ComposerDraftState> = {}): ComposerDraftState {
  return {
    conversationId: 'conv-1',
    draftText: '',
    submitState: 'idle',
    validationMessage: null,
    ...overrides,
  };
}

// ─── getDraft ───────────────────────────────────────────────────────────────

describe('getDraft', () => {
  it('returns the draft for an existing conversation', () => {
    const state = stateWithDraft('conv-1', 'hello');
    const draft = getDraft(state, 'conv-1');
    assert.equal(draft?.draftText, 'hello');
    assert.equal(draft?.conversationId, 'conv-1');
  });

  it('returns undefined for a conversation with no draft', () => {
    const state = createInitialWorkspaceState();
    assert.equal(getDraft(state, 'conv-missing'), undefined);
  });

  it('returns distinct drafts for different conversations', () => {
    let state = stateWithDraft('conv-1', 'first');
    state = reduceWorkspaceState(state, {
      type: 'conversation/select',
      conversationId: 'conv-2',
    });
    state = reduceWorkspaceState(state, {
      type: 'draft/set-text',
      conversationId: 'conv-2',
      draftText: 'second',
    });

    assert.equal(getDraft(state, 'conv-1')?.draftText, 'first');
    assert.equal(getDraft(state, 'conv-2')?.draftText, 'second');
  });
});

// ─── getActiveDraft ─────────────────────────────────────────────────────────

describe('getActiveDraft', () => {
  it('returns the draft for the active conversation', () => {
    const state = stateWithDraft('conv-1', 'active text');
    const draft = getActiveDraft(state);
    assert.equal(draft?.draftText, 'active text');
    assert.equal(draft?.conversationId, 'conv-1');
  });

  it('returns undefined when no conversation is active', () => {
    const state = createInitialWorkspaceState();
    assert.equal(getActiveDraft(state), undefined);
  });

  it('follows the active conversation when switching', () => {
    let state = stateWithDraft('conv-1', 'first draft');
    state = reduceWorkspaceState(state, {
      type: 'conversation/select',
      conversationId: 'conv-2',
    });
    state = reduceWorkspaceState(state, {
      type: 'draft/set-text',
      conversationId: 'conv-2',
      draftText: 'second draft',
    });

    const draft = getActiveDraft(state);
    assert.equal(draft?.conversationId, 'conv-2');
    assert.equal(draft?.draftText, 'second draft');
  });
});

// ─── isDraftNonEmpty ────────────────────────────────────────────────────────

describe('isDraftNonEmpty', () => {
  it('returns false for an empty string', () => {
    assert.equal(isDraftNonEmpty(makeDraft({ draftText: '' })), false);
  });

  it('returns false for whitespace-only text', () => {
    assert.equal(isDraftNonEmpty(makeDraft({ draftText: '   \n\t  ' })), false);
  });

  it('returns true for non-whitespace text', () => {
    assert.equal(isDraftNonEmpty(makeDraft({ draftText: 'hello' })), true);
  });

  it('returns true for text with leading/trailing whitespace', () => {
    assert.equal(isDraftNonEmpty(makeDraft({ draftText: '  hello  ' })), true);
  });
});

// ─── isDraftSubmittable ─────────────────────────────────────────────────────

describe('isDraftSubmittable', () => {
  it('returns true when draft is non-empty and idle', () => {
    assert.equal(isDraftSubmittable(makeDraft({ draftText: 'go' })), true);
  });

  it('returns false when draft text is empty', () => {
    assert.equal(isDraftSubmittable(makeDraft({ draftText: '' })), false);
  });

  it('returns false when draft text is whitespace-only', () => {
    assert.equal(isDraftSubmittable(makeDraft({ draftText: '   ' })), false);
  });

  it('returns false when draft is currently submitting', () => {
    assert.equal(
      isDraftSubmittable(makeDraft({ draftText: 'go', submitState: 'submitting' })),
      false,
    );
  });

  it('returns false when draft has a submit error', () => {
    assert.equal(isDraftSubmittable(makeDraft({ draftText: 'go', submitState: 'error' })), false);
  });
});

// ─── hasDraftError ──────────────────────────────────────────────────────────

describe('hasDraftError', () => {
  it('returns true when submitState is error', () => {
    assert.equal(
      hasDraftError(makeDraft({ submitState: 'error', validationMessage: 'Too long' })),
      true,
    );
  });

  it('returns false when submitState is idle', () => {
    assert.equal(hasDraftError(makeDraft({ submitState: 'idle' })), false);
  });

  it('returns false when submitState is submitting', () => {
    assert.equal(hasDraftError(makeDraft({ submitState: 'submitting' })), false);
  });
});
