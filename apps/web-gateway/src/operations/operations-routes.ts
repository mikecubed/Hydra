/**
 * Operations routes — authenticated gateway surface for operations panels.
 *
 * Phase 0 provides only the route module scaffold so later phases can add
 * snapshot/detail/control mediation without mixing concerns into conversation
 * transport files.
 */
import { Hono } from 'hono';
import type { GatewayEnv } from '../shared/types.ts';
import type { DaemonOperationsClient } from './daemon-operations-client.ts';

export interface OperationsRoutesDeps {
  readonly daemonClient: DaemonOperationsClient;
}

export function createOperationsRoutes(_deps: OperationsRoutesDeps): Hono<GatewayEnv> {
  return new Hono<GatewayEnv>();
}
