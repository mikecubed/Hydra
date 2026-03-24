/**
 * Artifact hydration helpers for T041 — artifact inspection integration.
 *
 * Provides pure functions for mapping REST artifact payloads to workspace
 * types and building ArtifactViewState from fetched content. Used by the
 * workspace route to hydrate artifact references on transcript entries
 * after REST history load (where Turn payloads do not include artifacts).
 */

import type { Artifact } from '@hydra/web-contracts';
import type {
  ArtifactReferenceState,
  ArtifactViewState,
  WorkspaceAction,
} from './workspace-types.ts';
import { isCodeLikeArtifact } from '../render/artifact-render-utils.ts';

/**
 * Map an array of REST `Artifact` objects to `ArtifactReferenceState[]`.
 * All hydrated artifacts start with `availability: 'listed'` because their
 * content has not been fetched yet.
 */
export function hydrateEntryArtifacts(
  artifacts: readonly Artifact[],
): readonly ArtifactReferenceState[] {
  return artifacts.map((a) => ({
    artifactId: a.id,
    kind: a.kind,
    label: a.label,
    availability: 'listed' as const,
  }));
}

/**
 * Build a fully-ready `ArtifactViewState` from an artifact metadata object
 * and its fetched content string.
 *
 * The content is placed in a single preview block whose kind is determined
 * by the artifact's classification (code-like → 'code', otherwise → 'text').
 */
export function buildArtifactViewFromContent(
  artifact: Artifact,
  content: string,
): ArtifactViewState {
  const blockKind = isCodeLikeArtifact(artifact.kind) ? 'code' : 'text';

  return {
    artifactId: artifact.id,
    turnId: artifact.turnId,
    kind: artifact.kind,
    label: artifact.label,
    availability: 'ready',
    previewBlocks: [
      {
        blockId: `${artifact.id}-content`,
        kind: blockKind,
        text: content,
        metadata: null,
      },
    ],
  };
}

// ─── Extracted async helpers (testable without React) ───────────────────────

/** Minimal client surface needed for hydration. */
export interface HydrationClient {
  listArtifactsForTurn(turnId: string): Promise<{ artifacts: readonly Artifact[] }>;
}

/** Minimal dispatch surface needed for hydration and artifact selection. */
export interface HydrationDispatch {
  (action: WorkspaceAction): void;
}

/**
 * Hydrate artifact references for a set of turns in a conversation.
 *
 * Only marks a turn as hydrated (in `hydratedTurns`) on success.
 * Failed turns are *not* recorded, so a subsequent call can retry them.
 *
 * @returns The set of turn IDs that failed hydration.
 */
export async function hydrateConversationArtifacts(
  conversationId: string,
  turnIds: readonly string[],
  client: HydrationClient,
  dispatch: HydrationDispatch,
  hydratedTurns: Set<string>,
): Promise<ReadonlySet<string>> {
  const failed = new Set<string>();
  for (const turnId of turnIds) {
    try {
      const response = await client.listArtifactsForTurn(turnId);
      if (response.artifacts.length > 0) {
        const refs = hydrateEntryArtifacts(response.artifacts);
        dispatch({
          type: 'entry/hydrate-artifacts',
          conversationId,
          turnId,
          artifacts: refs,
        });
      }
      hydratedTurns.add(turnId);
    } catch {
      failed.add(turnId);
    }
  }
  return failed;
}

/** Minimal client surface needed for artifact content fetch. */
export interface ArtifactContentClient {
  getArtifactContent(
    artifactId: string,
  ): Promise<{ artifact: Artifact; content: string }>;
}

/**
 * Fetch artifact content and dispatch `artifact/show`, with a staleness guard.
 *
 * Before dispatching the async result the function checks `getCurrentRequestId()`.
 * If it no longer matches the `requestId` captured at call time, the response
 * is silently dropped — preventing stale content from overwriting the UI after
 * panel close, conversation switch, or a newer artifact selection.
 */
export async function fetchArtifactContent(
  artifactId: string,
  requestId: number,
  getCurrentRequestId: () => number,
  client: ArtifactContentClient,
  dispatch: HydrationDispatch,
  loadingArtifact: ArtifactViewState,
): Promise<void> {
  try {
    const response = await client.getArtifactContent(artifactId);
    if (getCurrentRequestId() !== requestId) return;
    const artifactView = buildArtifactViewFromContent(response.artifact, response.content);
    dispatch({ type: 'artifact/show', artifact: artifactView });
  } catch (err: unknown) {
    if (getCurrentRequestId() !== requestId) return;
    console.warn('[artifact-select] Failed to load artifact content:', err);
    dispatch({
      type: 'artifact/show',
      artifact: { ...loadingArtifact, availability: 'error' },
    });
  }
}
