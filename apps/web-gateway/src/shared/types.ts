/**
 * Shared Hono environment type for the web-gateway.
 * Defines context variables set by middleware and consumed by route handlers.
 */
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { GatewayError } from './errors.ts';

export type GatewayEnv = {
  Variables: {
    operatorId: string;
    sessionId: string;
    csrfToken: string;
    sourceKey: string;
  };
};

/** Return a JSON error response from a GatewayError. */
export function gatewayErrorResponse(c: Context, err: GatewayError): Response {
  return c.json({ code: err.code, message: err.message }, err.statusCode as ContentfulStatusCode);
}
