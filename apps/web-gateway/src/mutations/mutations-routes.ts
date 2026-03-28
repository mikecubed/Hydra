/**
 * Mutations routes — authenticated gateway surface for config mutations.
 *
 * Phases 2+4 provide: GET /config/safe, POST /config/routing/mode,
 * POST /config/models/:agent/active, POST /config/usage/budget,
 * POST /workflows/launch, GET /audit.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { GatewayEnv } from '../shared/types.ts';
import type { AuditService } from '../audit/audit-service.ts';
import type { DaemonMutationsClient } from './daemon-mutations-client.ts';
import {
  validateRoutingModeBody,
  validateModelTierBody,
  validateBudgetBody,
  validateWorkflowLaunchBody,
  validateAuditParams,
} from './request-validator.ts';
import { translateMutationError } from './response-translator.ts';
import type { ValidationResult } from './request-validator.ts';
import type { DaemonMutationsResult } from './daemon-mutations-client.ts';

async function tryAudit(
  auditService: AuditService | undefined,
  eventType: string,
  operatorId: string | null,
  sessionId: string | null,
  detail: Record<string, unknown>,
  outcome: 'success' | 'failure',
): Promise<void> {
  if (!auditService) return;
  try {
    await auditService.record(eventType, operatorId, sessionId, detail, outcome);
  } catch {
    /* never fail the request on audit write errors */
  }
}

interface PostMutationOpts<TData, TResult> {
  c: Context<GatewayEnv>;
  auditService: AuditService | undefined;
  validated: ValidationResult<TData>;
  execute: (data: TData) => Promise<DaemonMutationsResult<TResult>>;
  successEvent: string;
  successDetail: (data: TData) => Record<string, unknown>;
  failureContext?: Record<string, unknown>;
}

async function handlePostMutation<TData, TResult>(
  opts: PostMutationOpts<TData, TResult>,
): Promise<Response> {
  const {
    c,
    auditService,
    validated,
    execute,
    successEvent,
    successDetail,
    failureContext = {},
  } = opts;
  const operatorId = c.get('operatorId');
  const sessionId = c.get('sessionId');
  if (!validated.ok) {
    await tryAudit(
      auditService,
      'config.mutation.rejected',
      operatorId,
      sessionId,
      {
        path: c.req.path,
        ...failureContext,
        reason: validated.message,
      },
      'failure',
    );
    return c.json({ error: validated.message }, 400);
  }
  const result = await execute(validated.data);
  if ('error' in result) {
    const { status, message } = translateMutationError(result.error.category);
    await tryAudit(
      auditService,
      'config.mutation.rejected',
      operatorId,
      sessionId,
      {
        path: c.req.path,
        ...failureContext,
        reason: message,
      },
      'failure',
    );
    return c.json({ error: message }, status as ContentfulStatusCode);
  }
  await tryAudit(
    auditService,
    successEvent,
    operatorId,
    sessionId,
    successDetail(validated.data),
    'success',
  );
  return c.json(result.data);
}

function createConfigMutationsRouter(
  daemonClient: DaemonMutationsClient,
  auditService: AuditService | undefined,
): Hono<GatewayEnv> {
  const app = new Hono<GatewayEnv>();

  app.get('/config/safe', async (c) => {
    const result = await daemonClient.getSafeConfig();
    if ('error' in result) {
      const { status, message } = translateMutationError(result.error.category);
      return c.json({ error: message }, status as ContentfulStatusCode);
    }
    return c.json(result.data);
  });

  app.post('/config/routing/mode', async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    return handlePostMutation({
      c,
      auditService,
      validated: validateRoutingModeBody(body),
      execute: (data) => daemonClient.postRoutingMode(data),
      successEvent: 'config.routing.mode.changed',
      successDetail: (data) => ({ mode: data.mode }),
    });
  });

  app.post('/config/models/:agent/active', async (c) => {
    const agent = c.req.param('agent');
    const body: unknown = await c.req.json().catch(() => null);
    return handlePostMutation({
      c,
      auditService,
      validated: validateModelTierBody(agent, body),
      execute: (data) =>
        daemonClient.postModelTier(agent, {
          tier: data.tier,
          expectedRevision: data.expectedRevision,
        }),
      successEvent: 'config.models.active.changed',
      successDetail: (data) => ({ agent, tier: data.tier }),
      failureContext: { agent },
    });
  });

  app.post('/config/usage/budget', async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    return handlePostMutation({
      c,
      auditService,
      validated: validateBudgetBody(body),
      execute: (data) => daemonClient.postBudget(data),
      successEvent: 'config.usage.budget.changed',
      successDetail: (data) => ({ modelId: data.modelId }),
    });
  });

  return app;
}

function createWorkflowAuditRouter(
  daemonClient: DaemonMutationsClient,
  auditService: AuditService | undefined,
): Hono<GatewayEnv> {
  const app = new Hono<GatewayEnv>();

  app.post('/workflows/launch', async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const validated = validateWorkflowLaunchBody(body);
    const operatorId = c.get('operatorId');
    const sessionId = c.get('sessionId');
    if (!validated.ok) {
      await tryAudit(
        auditService,
        'workflow.launch.rejected',
        operatorId,
        sessionId,
        { path: c.req.path, reason: validated.message },
        'failure',
      );
      return c.json({ error: validated.message }, 400);
    }
    const result = await daemonClient.postWorkflowLaunch(validated.data);
    if ('error' in result) {
      const { status, message } = translateMutationError(result.error.category);
      await tryAudit(
        auditService,
        'workflow.launch.rejected',
        operatorId,
        sessionId,
        { workflow: validated.data.workflow, reason: message },
        'failure',
      );
      return c.json({ error: message }, status as ContentfulStatusCode);
    }
    await tryAudit(
      auditService,
      'workflow.launched',
      operatorId,
      sessionId,
      { workflow: result.data.workflow, taskId: result.data.taskId },
      'success',
    );
    return c.json(result.data, 202);
  });

  app.get('/audit', async (c) => {
    const rawLimit = c.req.query('limit');
    const rawCursor = c.req.query('cursor');
    const queryObj: Record<string, unknown> = {};
    if (rawLimit !== undefined) queryObj['limit'] = Number(rawLimit);
    if (rawCursor !== undefined) queryObj['cursor'] = rawCursor;
    const validated = validateAuditParams(queryObj);
    if (!validated.ok) {
      return c.json({ error: validated.message }, 400);
    }
    const result = await daemonClient.getAudit(validated.data);
    if ('error' in result) {
      const { status, message } = translateMutationError(result.error.category);
      return c.json({ error: message }, status as ContentfulStatusCode);
    }
    return c.json(result.data);
  });

  return app;
}

export function createMutationsRouter(
  daemonClient: DaemonMutationsClient,
  auditService?: AuditService,
): Hono<GatewayEnv> {
  const app = new Hono<GatewayEnv>();
  app.route('/', createConfigMutationsRouter(daemonClient, auditService));
  app.route('/', createWorkflowAuditRouter(daemonClient, auditService));
  return app;
}
