/**
 * Conversation entity — top-level container for operator-system interaction.
 *
 * Persists across browser sessions and survives disconnection.
 * Fork references must be provided together or not at all.
 */
import { z } from 'zod';

export const ConversationStatus = z.enum(['active', 'archived']);
export type ConversationStatus = z.infer<typeof ConversationStatus>;

export const Conversation = z
  .object({
    id: z.string().min(1),
    title: z.string().optional(),
    status: ConversationStatus,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    turnCount: z.number().int().nonnegative(),
    parentConversationId: z.string().min(1).optional(),
    forkPointTurnId: z.string().min(1).optional(),
    pendingInstructionCount: z.number().int().nonnegative(),
  })
  .refine(
    (data) => {
      const hasParent = data.parentConversationId !== undefined;
      const hasForkPoint = data.forkPointTurnId !== undefined;
      return hasParent === hasForkPoint;
    },
    {
      message: 'parentConversationId and forkPointTurnId must both be present or both absent',
      path: ['forkPointTurnId'],
    },
  );
export type Conversation = z.infer<typeof Conversation>;
