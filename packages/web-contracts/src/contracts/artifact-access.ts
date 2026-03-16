/**
 * Artifact Access contracts — list and retrieve artifacts.
 */
import { z } from 'zod';
import { Artifact } from '../artifact.ts';

// ── ListArtifactsForTurn ─────────────────────────────────────────────────────

export const ListArtifactsForTurnRequest = z.object({
  turnId: z.string().min(1),
});
export type ListArtifactsForTurnRequest = z.infer<typeof ListArtifactsForTurnRequest>;

export const ListArtifactsForTurnResponse = z.object({
  artifacts: z.array(Artifact),
});
export type ListArtifactsForTurnResponse = z.infer<typeof ListArtifactsForTurnResponse>;

// ── GetArtifactContent ───────────────────────────────────────────────────────

export const GetArtifactContentRequest = z.object({
  artifactId: z.string().min(1),
});
export type GetArtifactContentRequest = z.infer<typeof GetArtifactContentRequest>;

export const GetArtifactContentResponse = z.object({
  artifact: Artifact,
  content: z.string(),
});
export type GetArtifactContentResponse = z.infer<typeof GetArtifactContentResponse>;

// ── ListArtifactsForConversation ─────────────────────────────────────────────

export const ListArtifactsForConversationRequest = z.object({
  conversationId: z.string().min(1),
  kind: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.number().int().positive().max(100).default(20),
});
export type ListArtifactsForConversationRequest = z.infer<
  typeof ListArtifactsForConversationRequest
>;

export const ListArtifactsForConversationResponse = z.object({
  artifacts: z.array(Artifact),
  nextCursor: z.string().optional(),
  totalCount: z.number().int().nonnegative(),
});
export type ListArtifactsForConversationResponse = z.infer<
  typeof ListArtifactsForConversationResponse
>;
