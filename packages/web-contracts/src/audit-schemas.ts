/**
 * Audit schemas — append-only audit record types.
 *
 * Write-side only in this slice. Query routes deferred to Phase 4 (FR-014).
 */
import { z } from 'zod';

// ─── AuditEventType enum (18 in-scope types) ────────────────────────────────

export const AuditEventType = z.enum([
  'auth.attempt.success',
  'auth.attempt.failure',
  'auth.rate-limited',
  'session.created',
  'session.extended',
  'session.expired',
  'session.invalidated',
  'session.logged-out',
  'session.daemon-unreachable',
  'session.daemon-restored',
  'session.idle-reauth',
  'session.idle-timeout',
  'config.routing.mode.changed',
  'config.models.active.changed',
  'config.usage.budget.changed',
  'workflow.launched',
  'config.mutation.rejected',
  'workflow.launch.rejected',
]);
export type AuditEventType = z.infer<typeof AuditEventType>;

// ─── AuditRecord ─────────────────────────────────────────────────────────────

export const AuditRecord = z.object({
  id: z.string().min(1),
  timestamp: z.iso.datetime(),
  eventType: AuditEventType,
  operatorId: z.string().nullable(),
  sessionId: z.string().nullable(),
  outcome: z.enum(['success', 'failure']),
  detail: z.record(z.string(), z.unknown()),
  sourceIp: z.string().optional(),
});
export type AuditRecord = z.infer<typeof AuditRecord>;

// ─── MutationAuditRecord ─────────────────────────────────────────────────────

export const MutationAuditRecord = z.object({
  id: z.string().min(1),
  timestamp: z.iso.datetime(),
  eventType: AuditEventType,
  operatorId: z.string().nullable(),
  sessionId: z.string().nullable(),
  targetField: z.string(),
  beforeValue: z.unknown(),
  afterValue: z.unknown(),
  outcome: z.enum(['success', 'failure']),
  rejectionReason: z.string().nullable(),
  sourceIp: z.string(),
});
export type MutationAuditRecord = z.infer<typeof MutationAuditRecord>;

// ─── AuditPageRequest / AuditPageResponse ────────────────────────────────────

export const AuditPageRequest = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});
export type AuditPageRequest = z.infer<typeof AuditPageRequest>;

export const AuditPageResponse = z.object({
  records: z.array(MutationAuditRecord),
  nextCursor: z.string().nullable(),
  totalCount: z.number().nullable().optional(),
});
export type AuditPageResponse = z.infer<typeof AuditPageResponse>;
