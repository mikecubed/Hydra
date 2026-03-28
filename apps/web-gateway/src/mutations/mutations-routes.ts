/**
 * Mutations routes — authenticated gateway surface for config mutations.
 *
 * Phase 1 provides GET /config/safe and POST /config/routing/mode.
 * Later phases add model tier, budget, workflow launch, and audit routes.
 */
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { GatewayEnv } from '../shared/types.ts';
import type { DaemonMutationsClient } from './daemon-mutations-client.ts';
import { validateRoutingModeBody } from './request-validator.ts';
import { translateMutationError } from './response-translator.ts';

export function createMutationsRouter(daemonClient: DaemonMutationsClient): Hono<GatewayEnv> {
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
    if (!validated.ok) {
      return c.json({ error: validated.message }, 400);
    }

    const result = await daemonClient.postRoutingMode(validated.data);
    if ('error' in result) {
      const { status, message } = translateMutationError(result.error.category);
      return c.json({ error: message }, status as ContentfulStatusCode);
    }
    return c.json(result.data);
  });

  return app;
}
