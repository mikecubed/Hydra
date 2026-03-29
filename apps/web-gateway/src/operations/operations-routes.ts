/**
 * Operations routes — authenticated gateway surface for operations panels.
 *
 * Phase 1 provides queue-visibility snapshot reads (US1, T010). Phase 2 adds
 * work-item detail reads (US2, T019). Phase 5 adds control reads, control
 * action submission, and batch control discovery (US5, T042). Routes validate
 * query/path/body params via shared Zod middleware and translate daemon errors
 * into the five-category GatewayErrorResponse shape.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { GatewayEnv } from '../shared/types.ts';
import {
  GetOperationsSnapshotRequest,
  SubmitControlActionBody,
  BatchControlDiscoveryRequest,
} from '@hydra/web-contracts';
import type { DaemonOperationsClient, DaemonOperationsResult } from './daemon-operations-client.ts';
import type { ErrorCategory, GatewayErrorResponse } from '../shared/gateway-error-response.ts';
import {
  parseOperationsQuery,
  validateWorkItemId,
  validateControlId,
  validateOperationsBody,
} from './request-validator.ts';

export interface OperationsRoutesDeps {
  readonly daemonClient: DaemonOperationsClient;
}

const CATEGORY_STATUS_MAP: Record<ErrorCategory, number> = {
  auth: 401,
  session: 409,
  validation: 400,
  daemon: 503,
  'rate-limit': 429,
  'stale-revision': 409,
  'daemon-unavailable': 503,
  'workflow-conflict': 409,
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
  app.get('/operations/snapshot', async (c) => {
    const queryResult = parseOperationsQuery(GetOperationsSnapshotRequest, c.req.url);
    if ('error' in queryResult) {
      return sendDaemonError(c, queryResult.error);
    }

    const query = queryResult.data;
    return handleResult(c, await dc.getOperationsSnapshot(query));
  });

  // US2 — selected work-item detail
  app.get('/operations/work-items/:workItemId', async (c) => {
    const paramResult = validateWorkItemId(c.req.param('workItemId'));
    if ('error' in paramResult) {
      return sendDaemonError(c, paramResult.error);
    }
    return handleResult(c, await dc.getWorkItemDetail(paramResult.data));
  });

  // US5 — work-item control reads
  app.get('/operations/work-items/:workItemId/controls', async (c) => {
    const paramResult = validateWorkItemId(c.req.param('workItemId'));
    if ('error' in paramResult) {
      return sendDaemonError(c, paramResult.error);
    }
    return handleResult(c, await dc.getWorkItemControls(paramResult.data));
  });

  // US5 — control action submission
  app.post(
    '/operations/work-items/:workItemId/controls/:controlId',
    validateOperationsBody(SubmitControlActionBody),
    async (c) => {
      const workItemResult = validateWorkItemId(c.req.param('workItemId'));
      if ('error' in workItemResult) {
        return sendDaemonError(c, workItemResult.error);
      }
      const controlResult = validateControlId(c.req.param('controlId'));
      if ('error' in controlResult) {
        return sendDaemonError(c, controlResult.error);
      }
      const body = c.get('validatedBody' as never) as SubmitControlActionBody;
      return handleResult(
        c,
        await dc.submitControlAction(workItemResult.data, controlResult.data, body),
      );
    },
  );

  // US5 — batch control discovery
  app.post(
    '/operations/controls/discover',
    validateOperationsBody(BatchControlDiscoveryRequest),
    async (c) => {
      const body = c.get('validatedBody' as never) as BatchControlDiscoveryRequest;
      return handleResult(c, await dc.discoverControls(body));
    },
  );

  return app;
}
