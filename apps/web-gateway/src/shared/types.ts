/**
 * Shared Hono environment type for the web-gateway.
 * Defines context variables set by middleware and consumed by route handlers.
 */
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { GatewayError } from './errors.ts';
import { createGatewayErrorResponse, type ErrorCategory } from './gateway-error-response.ts';

export type GatewayEnv = {
  Variables: {
    operatorId: string;
    sessionId: string;
    csrfToken: string;
    sourceKey: string;
  };
};

/** Map GatewayError codes to their ErrorCategory for structured responses. */
const ERROR_CODE_CATEGORY: Record<string, ErrorCategory> = {
  INVALID_CREDENTIALS: 'auth',
  RATE_LIMITED: 'rate-limit',
  ACCOUNT_DISABLED: 'auth',
  SESSION_EXPIRED: 'session',
  SESSION_INVALIDATED: 'session',
  SESSION_NOT_FOUND: 'auth',
  SESSION_NOT_IDLE: 'session',
  IDLE_TIMEOUT: 'session',
  BAD_REQUEST: 'validation',
  INTERNAL_ERROR: 'daemon',
  DAEMON_UNREACHABLE: 'daemon',
  CLOCK_UNRELIABLE: 'daemon',
  CSRF_INVALID: 'validation',
  ORIGIN_REJECTED: 'auth',
  CONVERSATION_NOT_FOUND: 'validation',
  TURN_NOT_FOUND: 'validation',
  VALIDATION_FAILED: 'validation',
  WS_INVALID_MESSAGE: 'validation',
  WS_BUFFER_OVERFLOW: 'daemon',
};

/** Return a structured GatewayErrorResponse JSON body from a GatewayError. */
export function gatewayErrorResponse(c: Context, err: GatewayError): Response {
  const category: ErrorCategory = ERROR_CODE_CATEGORY[err.code] ?? 'daemon';
  const body = createGatewayErrorResponse({
    code: err.code,
    category,
    message: err.message,
    httpStatus: err.statusCode,
  });
  return c.json(body, err.statusCode as ContentfulStatusCode);
}
