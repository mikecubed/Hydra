/**
 * Audit read contracts — gateway-layer request/response types for
 * paginated audit log queries.
 */
import { z } from 'zod';
import { AuditPageResponse } from '../audit-schemas.ts';

// ─── GET audit ───────────────────────────────────────────────────────────────

export const GetAuditRequest = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});
export type GetAuditRequest = z.infer<typeof GetAuditRequest>;

export const GetAuditResponse = AuditPageResponse;
export type GetAuditResponse = z.infer<typeof GetAuditResponse>;
