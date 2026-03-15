/**
 * Origin guard — validates Origin header on mutating routes and WS upgrade. (FR-021)
 */
import { createMiddleware } from 'hono/factory';
import type { MiddlewareHandler } from 'hono';
import { createError } from '../shared/errors.ts';
import { gatewayErrorResponse } from '../shared/types.ts';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function createOriginGuard(allowedOrigin: string): MiddlewareHandler {
  return createMiddleware(async (c, next) => {
    const method = c.req.method.toUpperCase();
    const isUpgrade = c.req.header('upgrade')?.toLowerCase() === 'websocket';

    if (!isUpgrade && SAFE_METHODS.has(method)) {
      await next();
      return;
    }

    const origin = c.req.header('origin');
    if (origin == null || origin !== allowedOrigin) {
      return gatewayErrorResponse(c, createError('ORIGIN_REJECTED'));
    }

    await next();
    // eslint-disable-next-line no-useless-return
    return;
  });
}
