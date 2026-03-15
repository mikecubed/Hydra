/**
 * Approval Flow contracts — get pending approvals, respond to approval.
 */
import { z } from 'zod';
import { ApprovalRequest } from '../approval.ts';

// ── GetPendingApprovals ──────────────────────────────────────────────────────

export const GetPendingApprovalsRequest = z.object({
  conversationId: z.string().min(1),
});
export type GetPendingApprovalsRequest = z.infer<typeof GetPendingApprovalsRequest>;

export const GetPendingApprovalsResponse = z.object({
  approvals: z.array(ApprovalRequest),
});
export type GetPendingApprovalsResponse = z.infer<typeof GetPendingApprovalsResponse>;

// ── RespondToApproval ────────────────────────────────────────────────────────

export const RespondToApprovalRequest = z.object({
  approvalId: z.string().min(1),
  response: z.string().min(1),
  sessionId: z.string().min(1),
  acknowledgeStaleness: z.boolean().default(false),
});
export type RespondToApprovalRequest = z.infer<typeof RespondToApprovalRequest>;

export const RespondToApprovalResponse = z.object({
  success: z.boolean(),
  approval: ApprovalRequest,
  conflictNotification: z
    .object({
      conflictingSessionId: z.string().min(1),
      message: z.string(),
    })
    .optional(),
});
export type RespondToApprovalResponse = z.infer<typeof RespondToApprovalResponse>;
