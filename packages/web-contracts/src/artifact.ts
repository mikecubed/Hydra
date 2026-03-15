/**
 * Artifact — a discrete output produced by a turn.
 *
 * Content is retrievable on-demand by id, not loaded inline with conversation.
 * Kind determines rendering strategy in the browser.
 */
import { z } from 'zod';

export const ArtifactKind = z.enum([
  'file',
  'diff',
  'patch',
  'test-result',
  'log',
  'plan',
  'structured-data',
]);
export type ArtifactKind = z.infer<typeof ArtifactKind>;

export const Artifact = z.object({
  id: z.string().min(1),
  turnId: z.string().min(1),
  kind: ArtifactKind,
  label: z.string().min(1),
  summary: z.string().optional(),
  size: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
});
export type Artifact = z.infer<typeof Artifact>;
