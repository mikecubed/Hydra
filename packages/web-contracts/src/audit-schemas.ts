/**
 * Audit schemas — append-only audit record types.
 *
 * Write-side only in this slice. Query routes deferred to Phase 4 (FR-014).
 */
import { z } from 'zod';

// ─── AuditEventType enum (11 in-scope types) ────────────────────────────────

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
