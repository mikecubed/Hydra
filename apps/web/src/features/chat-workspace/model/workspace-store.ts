/**
 * Workspace store barrel — public API compatibility layer.
 *
 * Re-exports everything from the extracted modules so that existing consumers
 * continue to work with `import … from './workspace-store.ts'` unchanged.
 *
 * Internal layout:
 *   workspace-types.ts   — domain type aliases & interfaces
 *   workspace-reducer.ts — pure reducer + initial-state factory
 *   submit-flow.ts       — async submit orchestration (side-effecting)
 */

// ─── Re-export: types ───────────────────────────────────────────────────────
export type {
  ArtifactAvailability,
  ArtifactReferenceState,
  ArtifactViewState,
  ComposerDraftState,
  ContentBlockKind,
  ContentBlockState,
  ConversationControlState,
  ConversationLineageState,
  ConversationLoadState,
  ConversationStatus,
  ConversationViewState,
  DraftSubmitState,
  EntryControlKind,
  EntryControlState,
  LineageRelationshipKind,
  PromptStatus,
  PromptViewState,
  TranscriptEntryKind,
  TranscriptEntryState,
  WorkspaceAction,
  WorkspaceConversationRecord,
  WorkspaceListener,
  WorkspaceState,
  WorkspaceStore,
} from './workspace-types.ts';

// ─── Re-export: reducer / state factory ─────────────────────────────────────
export {
  createInitialWorkspaceState,
  mergePromptState,
  reduceWorkspaceState,
} from './workspace-reducer.ts';

// ─── Re-export: submit orchestration ────────────────────────────────────────
export { submitComposerDraft, createAndSubmitDraft } from './submit-flow.ts';
export type { SubmitDraftDeps, SubmitPort, SubmitResult } from './submit-flow.ts';

// ─── Re-export: stream subscription ─────────────────────────────────────────
export {
  applyStreamEventsToConversation,
  buildStreamCallbacks,
  computeContiguousResume,
  createStreamSubscriptionState,
  sealSubscriptionAfterMerge,
} from './stream-subscription.ts';
export type { StreamLifecycleHooks, StreamSubscriptionState } from './stream-subscription.ts';

// ─── Store factory (thin wrapper over reducer) ──────────────────────────────

import { createInitialWorkspaceState, reduceWorkspaceState } from './workspace-reducer.ts';
import type {
  WorkspaceAction,
  WorkspaceListener,
  WorkspaceState,
  WorkspaceStore,
} from './workspace-types.ts';

export function createWorkspaceStore(initialState?: WorkspaceState): WorkspaceStore {
  let currentState = initialState ?? createInitialWorkspaceState();
  const listeners = new Set<WorkspaceListener>();

  return {
    getState(): WorkspaceState {
      return currentState;
    },

    dispatch(action: WorkspaceAction): void {
      currentState = reduceWorkspaceState(currentState, action);
      for (const listener of listeners) {
        listener(currentState, action);
      }
    },

    subscribe(listener: WorkspaceListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
