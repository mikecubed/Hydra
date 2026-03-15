/**
 * Auth middleware — reads __session HttpOnly cookie, validates via session service,
 * rejects if missing/invalid, attaches operator context on success. (FR-001)
 */
import { createMiddleware } from 'hono/factory';
import { getCookie } from 'hono/cookie';
import type { MiddlewareHandler } from 'hono';
import { type SessionService } from '../session/session-service.ts';
import { createError, type GatewayError } from '../shared/errors.ts';
import { type GatewayEnv, gatewayErrorResponse } from '../shared/types.ts';
import type { AuditService } from '../audit/audit-service.ts';

export type { GatewayEnv };

export function createAuthMiddleware(
  sessionService: SessionService,
  auditService?: AuditService,
): MiddlewareHandler<GatewayEnv> {
  return createMiddleware<GatewayEnv>(async (c, next) => {
    const sessionId = getCookie(c, '__session');

    if (!sessionId) {
      return gatewayErrorResponse(c, createError('SESSION_NOT_FOUND'));
    }

    try {
      const session = await sessionService.validate(sessionId);

      if (sessionService.isIdle(session)) {
        await auditService?.record(
          'session.idle-timeout',
          session.operatorId,
          sessionId,
          {},
          'failure',
        );
        return gatewayErrorResponse(c, createError('IDLE_TIMEOUT'));
      }

      sessionService.touchActivity(sessionId);

      c.set('operatorId', session.operatorId);
      c.set('sessionId', sessionId);
      c.set('csrfToken', session.csrfToken);
      await next();
      // eslint-disable-next-line no-useless-return
      return;
    } catch (err) {
      if (err != null && typeof err === 'object' && 'code' in err) {
        return gatewayErrorResponse(c, err as GatewayError);
      }
      return c.json(
        { code: 'INTERNAL_ERROR', message: 'Internal server error' },
        500,
      );
    }
  });
}
