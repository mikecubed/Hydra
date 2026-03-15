/**
 * Conversation Lifecycle contracts — create, open, resume, archive, list.
 */
import { z } from 'zod';
import { Conversation } from '../conversation.ts';
import { Turn } from '../turn.ts';
import { ApprovalRequest } from '../approval.ts';
import { StreamEvent } from '../stream.ts';

// ── CreateConversation ───────────────────────────────────────────────────────

export const CreateConversationRequest = z.object({
  title: z.string().optional(),
  parentConversationId: z.string().min(1).optional(),
  forkPointTurnId: z.string().min(1).optional(),
});
export type CreateConversationRequest = z.infer<typeof CreateConversationRequest>;

export const CreateConversationResponse = Conversation;
export type CreateConversationResponse = z.infer<typeof CreateConversationResponse>;

// ── OpenConversation ─────────────────────────────────────────────────────────

export const OpenConversationRequest = z.object({
  conversationId: z.string().min(1),
});
export type OpenConversationRequest = z.infer<typeof OpenConversationRequest>;

export const OpenConversationResponse = z.object({
  conversation: Conversation,
  recentTurns: z.array(Turn),
  totalTurnCount: z.number().int().nonnegative(),
  pendingApprovals: z.array(ApprovalRequest),
});
export type OpenConversationResponse = z.infer<typeof OpenConversationResponse>;

// ── ResumeConversation (reconnect) ───────────────────────────────────────────

export const ResumeConversationRequest = z.object({
  conversationId: z.string().min(1),
  lastAcknowledgedSeq: z.number().int().nonnegative(),
});
export type ResumeConversationRequest = z.infer<typeof ResumeConversationRequest>;

export const ResumeConversationResponse = z.object({
  conversation: Conversation,
  events: z.array(StreamEvent),
  pendingApprovals: z.array(ApprovalRequest),
});
export type ResumeConversationResponse = z.infer<typeof ResumeConversationResponse>;

// ── ArchiveConversation ──────────────────────────────────────────────────────

export const ArchiveConversationRequest = z.object({
  conversationId: z.string().min(1),
});
export type ArchiveConversationRequest = z.infer<typeof ArchiveConversationRequest>;

export const ArchiveConversationResponse = z.object({
  success: z.boolean(),
});
export type ArchiveConversationResponse = z.infer<typeof ArchiveConversationResponse>;

// ── ListConversations ────────────────────────────────────────────────────────

export const ListConversationsRequest = z.object({
  status: z.enum(['active', 'archived']).optional(),
  cursor: z.string().optional(),
  limit: z.number().int().positive().max(100).default(20),
});
export type ListConversationsRequest = z.infer<typeof ListConversationsRequest>;

export const ListConversationsResponse = z.object({
  conversations: z.array(Conversation),
  nextCursor: z.string().optional(),
  totalCount: z.number().int().nonnegative(),
});
export type ListConversationsResponse = z.infer<typeof ListConversationsResponse>;
