/**
 * Shared Hono environment type for the web-gateway.
 * Defines context variables set by middleware and consumed by route handlers.
 */
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ERROR_CATEGORY_MAP, type GatewayError } from './errors.ts';
import { createGatewayErrorResponse } from './gateway-error-response.ts';

export type GatewayEnv = {
  Variables: {
    operatorId: string;
    sessionId: string;
    csrfToken: string;
    sourceKey: string;
  };
};

/** Return a structured GatewayErrorResponse JSON body from a GatewayError. */
export function gatewayErrorResponse(c: Context, err: GatewayError): Response {
  const category = ERROR_CATEGORY_MAP[err.code];
  const body = createGatewayErrorResponse({
    code: err.code,
    category,
    message: err.message,
    httpStatus: err.statusCode,
  });
  return c.json(body, err.statusCode as ContentfulStatusCode);
}
