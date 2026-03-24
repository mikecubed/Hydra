/**
 * T041 — Artifact inspection integration tests.
 *
 * Covers:
 * 1. Reducer: `entry/hydrate-artifacts` action patches entry artifacts
 * 2. Pure helpers: `hydrateEntryArtifacts` maps REST artifacts → ArtifactReferenceState[]
 * 3. Pure helpers: `buildArtifactViewFromContent` builds ArtifactViewState from content response
 * 4. Store integration: artifact show/clear round-trips through store
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createWorkspaceStore,
  type ArtifactReferenceState,
  type ArtifactViewState,
  type TranscriptEntryState,
  type WorkspaceConversationRecord,
  type WorkspaceStore,
} from '../model/workspace-store.ts';
import {
  hydrateEntryArtifacts,
  buildArtifactViewFromContent,
} from '../model/artifact-hydration.ts';

// ─── Test helpers ───────────────────────────────────────────────────────────

function makeConversation(
  overrides: Partial<WorkspaceConversationRecord> = {},
): WorkspaceConversationRecord {
  return { id: 'conv-1', title: 'Test conversation', ...overrides };
}

function makeEntry(overrides: Partial<TranscriptEntryState> = {}): TranscriptEntryState {
  return {
    entryId: 'entry-1',
    kind: 'turn',
    turnId: 'turn-1',
    attributionLabel: null,
    status: 'completed',
    timestamp: '2026-01-01T00:00:00.000Z',
    contentBlocks: [],
    artifacts: [],
    controls: [],
    prompt: null,
    ...overrides,
  };
}

function seedConversationWithEntries(
  store: WorkspaceStore,
  conversationId: string,
  entries: readonly TranscriptEntryState[],
): void {
  store.dispatch({
    type: 'conversation/upsert',
    conversation: makeConversation({ id: conversationId }),
  });
  store.dispatch({ type: 'conversation/select', conversationId });
  store.dispatch({
    type: 'conversation/replace-entries',
    conversationId,
    entries,
    hasMoreHistory: false,
  });
}

// ─── hydrateEntryArtifacts ──────────────────────────────────────────────────

describe('hydrateEntryArtifacts', () => {
  it('maps REST artifacts to ArtifactReferenceState array', () => {
    const restArtifacts = [
      {
        id: 'art-1',
        turnId: 'turn-1',
        kind: 'file' as const,
        label: 'main.ts',
        size: 100,
        createdAt: '2026-01-01T00:00:00Z',
      },
      {
        id: 'art-2',
        turnId: 'turn-1',
        kind: 'diff' as const,
        label: 'patch.diff',
        size: 50,
        createdAt: '2026-01-01T00:00:00Z',
      },
    ];

    const result = hydrateEntryArtifacts(restArtifacts);
    assert.equal(result.length, 2);
    assert.deepEqual(result[0], {
      artifactId: 'art-1',
      kind: 'file',
      label: 'main.ts',
      availability: 'listed',
    });
    assert.deepEqual(result[1], {
      artifactId: 'art-2',
      kind: 'diff',
      label: 'patch.diff',
      availability: 'listed',
    });
  });

  it('returns empty array for empty input', () => {
    assert.deepEqual(hydrateEntryArtifacts([]), []);
  });

  it('sets availability to listed for all hydrated artifacts', () => {
    const result = hydrateEntryArtifacts([
      {
        id: 'a1',
        turnId: 't1',
        kind: 'log' as const,
        label: 'output.log',
        size: 10,
        createdAt: '2026-01-01T00:00:00Z',
      },
    ]);
    assert.equal(result[0]!.availability, 'listed');
  });
});

// ─── buildArtifactViewFromContent ───────────────────────────────────────────

describe('buildArtifactViewFromContent', () => {
  it('builds ArtifactViewState from artifact metadata and content', () => {
    const artifact = {
      id: 'art-1',
      turnId: 'turn-1',
      kind: 'file' as const,
      label: 'main.ts',
      size: 42,
      createdAt: '2026-01-01T00:00:00Z',
    };
    const content = 'console.log("hello");';

    const result = buildArtifactViewFromContent(artifact, content);
    assert.equal(result.artifactId, 'art-1');
    assert.equal(result.turnId, 'turn-1');
    assert.equal(result.kind, 'file');
    assert.equal(result.label, 'main.ts');
    assert.equal(result.availability, 'ready');
    assert.equal(result.previewBlocks.length, 1);
    assert.equal(result.previewBlocks[0]!.text, content);
  });

  it('uses code block kind for code-like artifacts', () => {
    const artifact = {
      id: 'art-1',
      turnId: 'turn-1',
      kind: 'diff' as const,
      label: 'change.diff',
      size: 10,
      createdAt: '2026-01-01T00:00:00Z',
    };

    const result = buildArtifactViewFromContent(artifact, '+ added line');
    assert.equal(result.previewBlocks[0]!.kind, 'code');
  });

  it('uses text block kind for prose artifacts', () => {
    const artifact = {
      id: 'art-1',
      turnId: 'turn-1',
      kind: 'plan' as const,
      label: 'plan.md',
      size: 10,
      createdAt: '2026-01-01T00:00:00Z',
    };

    const result = buildArtifactViewFromContent(artifact, 'Step 1: ...');
    assert.equal(result.previewBlocks[0]!.kind, 'text');
  });
});

// ─── Reducer: entry/hydrate-artifacts ───────────────────────────────────────

describe('reducer entry/hydrate-artifacts', () => {
  it('patches artifacts on a matching entry', () => {
    const store = createWorkspaceStore();
    const entry = makeEntry({ entryId: 'e1', turnId: 't1' });
    seedConversationWithEntries(store, 'conv-1', [entry]);

    const artifacts: readonly ArtifactReferenceState[] = [
      { artifactId: 'art-1', kind: 'file', label: 'main.ts', availability: 'listed' },
    ];

    store.dispatch({
      type: 'entry/hydrate-artifacts',
      conversationId: 'conv-1',
      turnId: 't1',
      artifacts,
    });

    const updated = store.getState().conversations.get('conv-1')!.entries[0]!;
    assert.equal(updated.artifacts.length, 1);
    assert.equal(updated.artifacts[0]!.artifactId, 'art-1');
  });

  it('does not affect entries in other conversations', () => {
    const store = createWorkspaceStore();
    seedConversationWithEntries(store, 'conv-1', [makeEntry({ turnId: 't1' })]);
    store.dispatch({
      type: 'conversation/upsert',
      conversation: makeConversation({ id: 'conv-2' }),
    });
    store.dispatch({
      type: 'conversation/replace-entries',
      conversationId: 'conv-2',
      entries: [makeEntry({ entryId: 'e2', turnId: 't2' })],
      hasMoreHistory: false,
    });

    store.dispatch({
      type: 'entry/hydrate-artifacts',
      conversationId: 'conv-1',
      turnId: 't1',
      artifacts: [{ artifactId: 'art-1', kind: 'file', label: 'f.ts', availability: 'listed' }],
    });

    const conv2Entry = store.getState().conversations.get('conv-2')!.entries[0]!;
    assert.equal(conv2Entry.artifacts.length, 0);
  });

  it('does nothing for unknown conversation', () => {
    const store = createWorkspaceStore();
    seedConversationWithEntries(store, 'conv-1', [makeEntry()]);

    const before = store.getState();
    store.dispatch({
      type: 'entry/hydrate-artifacts',
      conversationId: 'unknown',
      turnId: 't1',
      artifacts: [{ artifactId: 'a', kind: 'file', label: 'x', availability: 'listed' }],
    });

    assert.equal(store.getState(), before);
  });

  it('does nothing when no entry matches turnId', () => {
    const store = createWorkspaceStore();
    seedConversationWithEntries(store, 'conv-1', [makeEntry({ turnId: 't1' })]);

    const before = store.getState();
    store.dispatch({
      type: 'entry/hydrate-artifacts',
      conversationId: 'conv-1',
      turnId: 'non-existent',
      artifacts: [{ artifactId: 'a', kind: 'file', label: 'x', availability: 'listed' }],
    });

    assert.equal(store.getState(), before);
  });

  it('preserves existing artifacts that are not in the hydrated set', () => {
    const store = createWorkspaceStore();
    const existingArtifact: ArtifactReferenceState = {
      artifactId: 'existing-art',
      kind: 'log',
      label: 'existing.log',
      availability: 'ready',
    };
    const entry = makeEntry({ turnId: 't1', artifacts: [existingArtifact] });
    seedConversationWithEntries(store, 'conv-1', [entry]);

    store.dispatch({
      type: 'entry/hydrate-artifacts',
      conversationId: 'conv-1',
      turnId: 't1',
      artifacts: [
        { artifactId: 'new-art', kind: 'file', label: 'new.ts', availability: 'listed' },
      ],
    });

    const updated = store.getState().conversations.get('conv-1')!.entries[0]!;
    assert.equal(updated.artifacts.length, 2);
    // Existing kept
    assert.ok(updated.artifacts.some((a) => a.artifactId === 'existing-art'));
    // New added
    assert.ok(updated.artifacts.some((a) => a.artifactId === 'new-art'));
  });

  it('does not duplicate artifacts already present', () => {
    const store = createWorkspaceStore();
    const art: ArtifactReferenceState = {
      artifactId: 'art-1',
      kind: 'file',
      label: 'main.ts',
      availability: 'listed',
    };
    const entry = makeEntry({ turnId: 't1', artifacts: [art] });
    seedConversationWithEntries(store, 'conv-1', [entry]);

    store.dispatch({
      type: 'entry/hydrate-artifacts',
      conversationId: 'conv-1',
      turnId: 't1',
      artifacts: [{ artifactId: 'art-1', kind: 'file', label: 'main.ts', availability: 'listed' }],
    });

    const updated = store.getState().conversations.get('conv-1')!.entries[0]!;
    assert.equal(updated.artifacts.length, 1);
  });
});

// ─── Store: artifact show / clear round-trip ────────────────────────────────

describe('artifact show/clear store integration', () => {
  it('artifact/show sets visibleArtifact', () => {
    const store = createWorkspaceStore();
    const artifact: ArtifactViewState = {
      artifactId: 'art-1',
      turnId: 'turn-1',
      kind: 'file',
      label: 'main.ts',
      availability: 'ready',
      previewBlocks: [],
    };

    store.dispatch({ type: 'artifact/show', artifact });
    assert.deepEqual(store.getState().visibleArtifact, artifact);
  });

  it('artifact/clear resets visibleArtifact', () => {
    const store = createWorkspaceStore();
    const artifact: ArtifactViewState = {
      artifactId: 'art-1',
      turnId: 'turn-1',
      kind: 'file',
      label: 'main.ts',
      availability: 'ready',
      previewBlocks: [],
    };

    store.dispatch({ type: 'artifact/show', artifact });
    store.dispatch({ type: 'artifact/clear' });
    assert.equal(store.getState().visibleArtifact, null);
  });

  it('switching conversation clears visibleArtifact', () => {
    const store = createWorkspaceStore();
    const artifact: ArtifactViewState = {
      artifactId: 'art-1',
      turnId: 'turn-1',
      kind: 'file',
      label: 'main.ts',
      availability: 'ready',
      previewBlocks: [],
    };

    store.dispatch({
      type: 'conversation/upsert',
      conversation: makeConversation({ id: 'conv-1' }),
    });
    store.dispatch({ type: 'conversation/select', conversationId: 'conv-1' });
    store.dispatch({ type: 'artifact/show', artifact });
    store.dispatch({
      type: 'conversation/upsert',
      conversation: makeConversation({ id: 'conv-2' }),
    });
    store.dispatch({ type: 'conversation/select', conversationId: 'conv-2' });

    assert.equal(store.getState().visibleArtifact, null);
  });
});
