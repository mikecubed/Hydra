/**
 * Auth middleware — reads __session HttpOnly cookie, validates via session service,
 * rejects if missing/invalid, attaches operator context on success. (FR-001)
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { type SessionService } from '../session/session-service.ts';
import { createError, type GatewayError } from '../shared/errors.ts';
import { parseCookies } from '../shared/cookies.ts';

export { parseCookies };

export interface AuthenticatedRequest extends IncomingMessage {
  operatorId?: string;
  sessionId?: string;
  csrfToken?: string;
}

export function createAuthMiddleware(sessionService: SessionService) {
  return function authMiddleware(
    req: AuthenticatedRequest,
    res: ServerResponse,
    next: () => void,
  ): void {
    const cookies = parseCookies(req.headers.cookie);
    const sessionId = cookies['__session'];

    if (sessionId !== '') {
      sendError(res, createError('SESSION_NOT_FOUND'));
      return;
    }

    try {
      const session = sessionService.validate(sessionId);

      // Check idle timeout
      if (sessionService.isIdle(session)) {
        sendError(res, createError('IDLE_TIMEOUT'));
        return;
      }

      // Touch activity
      sessionService.touchActivity(sessionId);

      // Attach context
      req.operatorId = session.operatorId;
      req.sessionId = sessionId;
      req.csrfToken = session.csrfToken;
      next();
    } catch (err) {
      if (err != null && typeof err === 'object' && 'code' in err) {
        sendError(res, err as GatewayError);
      } else {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 'INTERNAL_ERROR', message: 'Internal server error' }));
      }
    }
  };
}

function sendError(res: ServerResponse, err: GatewayError): void {
  res.writeHead(err.statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ code: err.code, message: err.message }));
}
