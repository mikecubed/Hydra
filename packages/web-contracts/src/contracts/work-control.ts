/**
 * Work Control contracts — cancel, retry, fork, manage instruction queue.
 */
import { z } from 'zod';
import { Turn } from '../turn.ts';
import { Conversation } from '../conversation.ts';

// ── CancelWork ───────────────────────────────────────────────────────────────

export const CancelWorkRequest = z.object({
  conversationId: z.string().min(1),
  turnId: z.string().min(1),
});
export type CancelWorkRequest = z.infer<typeof CancelWorkRequest>;

export const CancelWorkResponse = z.object({
  success: z.boolean(),
  turn: Turn,
});
export type CancelWorkResponse = z.infer<typeof CancelWorkResponse>;

// ── RetryTurn ────────────────────────────────────────────────────────────────

export const RetryTurnRequest = z.object({
  conversationId: z.string().min(1),
  turnId: z.string().min(1),
});
export type RetryTurnRequest = z.infer<typeof RetryTurnRequest>;

export const RetryTurnResponse = z.object({
  turn: Turn,
  streamId: z.string().min(1),
});
export type RetryTurnResponse = z.infer<typeof RetryTurnResponse>;

// ── ForkConversation ─────────────────────────────────────────────────────────

export const ForkConversationRequest = z.object({
  conversationId: z.string().min(1),
  forkPointTurnId: z.string().min(1),
  title: z.string().optional(),
});
export type ForkConversationRequest = z.infer<typeof ForkConversationRequest>;

export const ForkConversationResponse = z.object({
  conversation: Conversation,
});
export type ForkConversationResponse = z.infer<typeof ForkConversationResponse>;

// ── ManageInstructionQueue ───────────────────────────────────────────────────

export const QueuedInstruction = z.object({
  id: z.string().min(1),
  instruction: z.string().min(1),
  queuedAt: z.iso.datetime(),
});
export type QueuedInstruction = z.infer<typeof QueuedInstruction>;

export const ManageQueueRequest = z.object({
  conversationId: z.string().min(1),
  action: z.enum(['list', 'reorder', 'remove']),
  instructionId: z.string().min(1).optional(),
  newPosition: z.number().int().nonnegative().optional(),
});
export type ManageQueueRequest = z.infer<typeof ManageQueueRequest>;

export const ManageQueueResponse = z.object({
  queue: z.array(QueuedInstruction),
});
export type ManageQueueResponse = z.infer<typeof ManageQueueResponse>;
