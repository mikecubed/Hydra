/**
 * Session routes — GET /info, POST /extend. (FR-005, FR-008)
 */
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { SessionService } from './session-service.ts';
import type { GatewayError } from '../shared/errors.ts';
import type { GatewayEnv } from '../shared/types.ts';

export function createSessionRoutes(sessionService: SessionService): Hono<GatewayEnv> {
  const app = new Hono<GatewayEnv>();

  app.get('/info', async (c) => {
    const sessionId = getCookie(c, '__session');
    if (!sessionId) {
      return c.json(
        { code: 'SESSION_NOT_FOUND', message: 'No session' },
        401,
      );
    }

    try {
      const session = await sessionService.validate(sessionId);
      return c.json({
        operatorId: session.operatorId,
        state: session.state,
        expiresAt: session.expiresAt,
        lastActivityAt: session.lastActivityAt,
        createdAt: session.createdAt,
      });
    } catch (err) {
      return sendSessionError(c, err);
    }
  });

  app.post('/extend', async (c) => {
    const sessionId = getCookie(c, '__session');
    if (!sessionId) {
      return c.json(
        { code: 'SESSION_NOT_FOUND', message: 'No session' },
        401,
      );
    }

    try {
      const session = await sessionService.extend(sessionId);
      return c.json({ newExpiresAt: session.expiresAt });
    } catch (err) {
      return sendSessionError(c, err);
    }
  });

  return app;
}

function sendSessionError(c: Context, err: unknown): Response {
  if (err != null && typeof err === 'object' && 'code' in err && 'statusCode' in err) {
    const gatewayErr = err as GatewayError;
    return c.json(
      { code: gatewayErr.code, message: gatewayErr.message },
      gatewayErr.statusCode as ContentfulStatusCode,
    );
  }
  return c.json({ code: 'INTERNAL_ERROR', message: 'Internal error' }, 500);
}
