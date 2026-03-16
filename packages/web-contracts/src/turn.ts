/**
 * Turn entity — a single interaction cycle within a conversation.
 *
 * One operator instruction + all resulting system work. Immutable once finalized.
 * Ordered by position within the conversation.
 */
import { z } from 'zod';
import { Attribution } from './attribution.ts';

export const TurnKind = z.enum(['operator', 'system']);
export type TurnKind = z.infer<typeof TurnKind>;

export const TurnStatus = z.enum(['submitted', 'executing', 'completed', 'failed', 'cancelled']);
export type TurnStatus = z.infer<typeof TurnStatus>;

export const Turn = z
  .object({
    id: z.string().min(1),
    conversationId: z.string().min(1),
    position: z.number().int().positive(),
    kind: TurnKind,
    attribution: Attribution,
    instruction: z.string().optional(),
    response: z.string().optional(),
    status: TurnStatus,
    parentTurnId: z.string().min(1).optional(),
    createdAt: z.iso.datetime(),
    completedAt: z.iso.datetime().optional(),
  })
  .refine(
    (data) => {
      if (data.kind === 'operator') return data.instruction !== undefined;
      return true;
    },
    { message: 'instruction is required for operator turns', path: ['instruction'] },
  );
export type Turn = z.infer<typeof Turn>;
