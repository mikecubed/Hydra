/**
 * CSRF middleware — double-submit cookie validation.
 * Reads __csrf cookie, compares to X-CSRF-Token header on mutating routes. (FR-022)
 */
import { createMiddleware } from 'hono/factory';
import { getCookie } from 'hono/cookie';
import type { MiddlewareHandler } from 'hono';
import { createError } from '../shared/errors.ts';
import { gatewayErrorResponse, type GatewayEnv } from '../shared/types.ts';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function createCsrfMiddleware(): MiddlewareHandler<GatewayEnv> {
  return createMiddleware<GatewayEnv>(async (c, next) => {
    if (SAFE_METHODS.has(c.req.method.toUpperCase())) {
      await next();
      return;
    }

    const cookieToken = getCookie(c, '__csrf');
    const headerToken = c.req.header('x-csrf-token');

    if (!cookieToken || !headerToken || cookieToken !== headerToken) {
      return gatewayErrorResponse(c, createError('CSRF_INVALID'));
    }

    await next();
    // eslint-disable-next-line no-useless-return
    return;
  });
}
