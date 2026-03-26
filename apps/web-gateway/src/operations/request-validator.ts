/**
 * Operations request validators.
 *
 * Operations routes reuse the gateway's shared Zod validation middleware while
 * keeping an operations-local import surface for future route additions.
 *
 * Path-param validation uses Zod safeParse directly — no middleware needed for
 * single-field path params; the route handler validates inline.
 */
import { z } from 'zod';
import { createGatewayErrorResponse } from '../shared/gateway-error-response.ts';
import type { GatewayErrorResponse } from '../shared/gateway-error-response.ts';

export {
  validateBody as validateOperationsBody,
  validateQuery as validateOperationsQuery,
} from '../conversation/request-validator.ts';

/** Schema for workItemId path parameter — non-empty string. */
export const WorkItemIdParam = z.string().min(1);

/**
 * Validate a workItemId path parameter. Returns the parsed value on success
 * or a GatewayErrorResponse on failure.
 */
export function validateWorkItemId(
  raw: string | undefined,
): { data: string } | { error: GatewayErrorResponse } {
  const result = WorkItemIdParam.safeParse(raw);
  if (!result.success) {
    return {
      error: createGatewayErrorResponse({
        code: 'VALIDATION_FAILED',
        category: 'validation',
        message: 'workItemId path parameter is required and must be non-empty',
      }),
    };
  }
  return { data: result.data };
}
