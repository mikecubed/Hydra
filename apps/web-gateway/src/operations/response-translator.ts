/**
 * Operations response translators.
 *
 * Extends the conversation-layer daemon-to-gateway error translation with
 * control-specific error code mappings for stale revisions, rejected authority,
 * and superseded mutations (US5).
 */
import type { ErrorCategory, GatewayErrorResponse } from '../shared/gateway-error-response.ts';
import { createGatewayErrorResponse } from '../shared/gateway-error-response.ts';
import {
  translateDaemonResponse,
  translateFetchFailure,
} from '../conversation/response-translator.ts';

export { translateFetchFailure as translateOperationsFetchFailure };

/**
 * Daemon error codes specific to control operations, mapped to gateway categories.
 */
const CONTROL_DAEMON_ERROR_MAP: Record<string, { code: string; category: ErrorCategory }> = {
  REVISION_STALE: { code: 'CONTROL_REVISION_STALE', category: 'session' },
  REVISION_SUPERSEDED: { code: 'CONTROL_REVISION_SUPERSEDED', category: 'session' },
  CONTROL_REJECTED: { code: 'CONTROL_REJECTED', category: 'validation' },
  AUTHORITY_DENIED: { code: 'CONTROL_AUTHORITY_DENIED', category: 'auth' },
};

/**
 * Translate a daemon HTTP error response to a GatewayErrorResponse, with
 * additional mappings for control-specific daemon error codes.
 */
export function translateOperationsDaemonResponse(
  status: number,
  payload: unknown,
): GatewayErrorResponse {
  if (payload && typeof payload === 'object') {
    const body = payload as { ok?: boolean; error?: string; message?: string };
    if (body.ok === false && typeof body.error === 'string') {
      const mapping = CONTROL_DAEMON_ERROR_MAP[body.error];
      if (mapping) {
        return createGatewayErrorResponse({
          code: mapping.code,
          category: mapping.category,
          message: body.message ?? `Control operation failed: ${body.error}`,
          httpStatus: status,
        });
      }
    }
  }
  return translateDaemonResponse(status, payload);
}
