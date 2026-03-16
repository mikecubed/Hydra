/**
 * ApprovalRequest — system-initiated pause requiring operator input.
 *
 * Four-state lifecycle: pending → responded | expired | stale.
 * Context-hash-based staleness detection prevents approving stale context.
 */
import { z } from 'zod';
import { Attribution } from './attribution.ts';

export const ApprovalStatus = z.enum(['pending', 'responded', 'expired', 'stale']);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

export const ApprovalResponseOption = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
});
export type ApprovalResponseOption = z.infer<typeof ApprovalResponseOption>;

export const ApprovalRequest = z.object({
  id: z.string().min(1),
  turnId: z.string().min(1),
  status: ApprovalStatus,
  prompt: z.string().min(1),
  context: z.record(z.string(), z.unknown()),
  contextHash: z.string().min(1),
  responseOptions: z.array(ApprovalResponseOption).min(1),
  response: z.string().optional(),
  respondedBy: Attribution.optional(),
  respondedAt: z.iso.datetime().optional(),
  createdAt: z.iso.datetime(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequest>;
