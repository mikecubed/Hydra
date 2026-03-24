/**
 * Artifact hydration helpers for T041 — artifact inspection integration.
 *
 * Provides pure functions for mapping REST artifact payloads to workspace
 * types and building ArtifactViewState from fetched content. Used by the
 * workspace route to hydrate artifact references on transcript entries
 * after REST history load (where Turn payloads do not include artifacts).
 */

import type { Artifact } from '@hydra/web-contracts';
import type { ArtifactReferenceState, ArtifactViewState } from './workspace-types.ts';
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
