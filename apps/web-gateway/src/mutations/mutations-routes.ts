/**
 * Mutations routes — authenticated gateway surface for config mutations.
 *
 * Phases 2+4 provide: GET /config/safe, POST /config/routing/mode,
 * POST /config/models/:agent/active, POST /config/usage/budget,
 * POST /workflows/launch, GET /audit.
 */
import { Hono } from 'hono';
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
    const validated = validateRoutingModeBody(body);
    const operatorId = c.get('operatorId');
    const sessionId = c.get('sessionId');
    if (!validated.ok) {
      await tryAudit(auditService, 'config.mutation.rejected', operatorId, sessionId, { path: c.req.path, reason: validated.message }, 'failure');
      return c.json({ error: validated.message }, 400);
    }
    const result = await daemonClient.postRoutingMode(validated.data);
    if ('error' in result) {
      const { status, message } = translateMutationError(result.error.category);
      await tryAudit(auditService, 'config.mutation.rejected', operatorId, sessionId, { path: c.req.path, reason: message }, 'failure');
      return c.json({ error: message }, status as ContentfulStatusCode);
    }
    await tryAudit(auditService, 'config.routing.mode.changed', operatorId, sessionId, { mode: validated.data.mode }, 'success');
    return c.json(result.data);
  });

  app.post('/config/models/:agent/active', async (c) => {
    const agent = c.req.param('agent');
    const body: unknown = await c.req.json().catch(() => null);
    const validated = validateModelTierBody(agent, body);
    const operatorId = c.get('operatorId');
    const sessionId = c.get('sessionId');
    if (!validated.ok) {
      await tryAudit(auditService, 'config.mutation.rejected', operatorId, sessionId, { path: c.req.path, agent, reason: validated.message }, 'failure');
      return c.json({ error: validated.message }, 400);
    }
    const { tier, expectedRevision } = validated.data;
    const result = await daemonClient.postModelTier(agent, { tier, expectedRevision });
    if ('error' in result) {
      const { status, message } = translateMutationError(result.error.category);
      await tryAudit(auditService, 'config.mutation.rejected', operatorId, sessionId, { path: c.req.path, agent, reason: message }, 'failure');
      return c.json({ error: message }, status as ContentfulStatusCode);
    }
    await tryAudit(auditService, 'config.models.active.changed', operatorId, sessionId, { agent, tier }, 'success');
    return c.json(result.data);
  });

  app.post('/config/usage/budget', async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const validated = validateBudgetBody(body);
    const operatorId = c.get('operatorId');
    const sessionId = c.get('sessionId');
    if (!validated.ok) {
      await tryAudit(auditService, 'config.mutation.rejected', operatorId, sessionId, { path: c.req.path, reason: validated.message }, 'failure');
      return c.json({ error: validated.message }, 400);
    }
    const result = await daemonClient.postBudget(validated.data);
    if ('error' in result) {
      const { status, message } = translateMutationError(result.error.category);
      await tryAudit(auditService, 'config.mutation.rejected', operatorId, sessionId, { path: c.req.path, reason: message }, 'failure');
      return c.json({ error: message }, status as ContentfulStatusCode);
    }
    await tryAudit(auditService, 'config.usage.budget.changed', operatorId, sessionId, { modelId: validated.data.modelId }, 'success');
    return c.json(result.data);
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
      await tryAudit(auditService, 'workflow.launch.rejected', operatorId, sessionId, { path: c.req.path, reason: validated.message }, 'failure');
      return c.json({ error: validated.message }, 400);
    }
    const result = await daemonClient.postWorkflowLaunch(validated.data);
    if ('error' in result) {
      const { status, message } = translateMutationError(result.error.category);
      await tryAudit(auditService, 'workflow.launch.rejected', operatorId, sessionId, { workflow: validated.data.workflow, reason: message }, 'failure');
      return c.json({ error: message }, status as ContentfulStatusCode);
    }
    await tryAudit(auditService, 'workflow.launched', operatorId, sessionId, { workflow: result.data.workflow, taskId: result.data.taskId }, 'success');
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
