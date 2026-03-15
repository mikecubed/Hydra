/**
 * Shared Error Response type — structured errors with conversation context.
 */
import { z } from 'zod';

export const ErrorCode = z.enum([
  'NOT_FOUND',
  'INVALID_INPUT',
  'CONFLICT',
  'ARCHIVED',
  'STALE_APPROVAL',
  'APPROVAL_ALREADY_RESPONDED',
  'TURN_NOT_TERMINAL',
  'TURN_NOT_ACTIVE',
  'QUEUE_FULL',
  'INTERNAL_ERROR',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorResponse = z.object({
  ok: z.literal(false),
  error: ErrorCode,
  message: z.string().min(1),
  conversationId: z.string().min(1).optional(),
  turnId: z.string().min(1).optional(),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;
