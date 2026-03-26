/**
 * Operations routes — authenticated gateway surface for operations panels.
 *
 * Phase 1 provides queue-visibility snapshot reads (US1, T010) using the
 * DaemonOperationsClient as the sole daemon communication point. Phase 2 adds
 * work-item detail reads (US2, T019). Routes validate query/path params via
 * shared Zod middleware and translate daemon errors into the five-category
 * GatewayErrorResponse shape.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { GatewayEnv } from '../shared/types.ts';
import { GetOperationsSnapshotRequest } from '@hydra/web-contracts';
import type { DaemonOperationsClient, DaemonOperationsResult } from './daemon-operations-client.ts';
import type { ErrorCategory, GatewayErrorResponse } from '../shared/gateway-error-response.ts';
import { validateOperationsQuery, validateWorkItemId } from './request-validator.ts';

export interface OperationsRoutesDeps {
  readonly daemonClient: DaemonOperationsClient;
}

const CATEGORY_STATUS_MAP: Record<ErrorCategory, number> = {
  auth: 401,
  session: 409,
  validation: 400,
  daemon: 503,
  'rate-limit': 429,
};

function sendDaemonError(c: Context<GatewayEnv>, error: GatewayErrorResponse): Response {
  const status = error.httpStatus ?? CATEGORY_STATUS_MAP[error.category];
  return c.json(error, status as ContentfulStatusCode);
}

function handleResult<T>(
  c: Context<GatewayEnv>,
  result: DaemonOperationsResult<T>,
  successStatus = 200,
): Response {
  if ('error' in result) {
    return sendDaemonError(c, result.error);
  }
  return c.json(result.data, successStatus as ContentfulStatusCode);
}

export function createOperationsRoutes(deps: OperationsRoutesDeps): Hono<GatewayEnv> {
  const app = new Hono<GatewayEnv>();
  const dc = deps.daemonClient;

  // US1 — queue visibility snapshot
  app.get(
    '/operations/snapshot',
    validateOperationsQuery(GetOperationsSnapshotRequest),
    async (c) => {
      const query = c.get('validatedQuery' as never) as Partial<GetOperationsSnapshotRequest>;
      return handleResult(c, await dc.getOperationsSnapshot(query));
    },
  );

  // US2 — selected work-item detail
  app.get('/operations/work-items/:workItemId', async (c) => {
    const paramResult = validateWorkItemId(c.req.param('workItemId'));
    if ('error' in paramResult) {
      return sendDaemonError(c, paramResult.error);
    }
    return handleResult(c, await dc.getWorkItemDetail(paramResult.data));
  });

  return app;
}
