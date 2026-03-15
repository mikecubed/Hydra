/**
 * Session routes — GET /session/info, POST /session/extend. (FR-005, FR-008)
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SessionService } from './session-service.ts';
import { parseCookies } from '../shared/cookies.ts';
import type { GatewayError } from '../shared/errors.ts';

/** Authenticated request with session context attached by auth middleware. */
interface AuthenticatedRequest extends IncomingMessage {
  operatorId?: string;
  sessionId?: string;
  csrfToken?: string;
}

export function createSessionRoutes(sessionService: SessionService): {
  handleGetInfo: (req: AuthenticatedRequest, res: ServerResponse) => void;
  handleExtend: (req: AuthenticatedRequest, res: ServerResponse) => void;
} {
  function handleGetInfo(req: AuthenticatedRequest, res: ServerResponse): void {
    const cookies = parseCookies(req.headers.cookie);
    const sessionId = cookies['__session'];

    if (sessionId === '') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 'SESSION_NOT_FOUND', message: 'No session' }));
      return;
    }

    try {
      const session = sessionService.validate(sessionId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          operatorId: session.operatorId,
          state: session.state,
          expiresAt: session.expiresAt,
          lastActivityAt: session.lastActivityAt,
          createdAt: session.createdAt,
        }),
      );
    } catch (err) {
      sendSessionError(res, err);
    }
  }

  function handleExtend(req: AuthenticatedRequest, res: ServerResponse): void {
    const cookies = parseCookies(req.headers.cookie);
    const sessionId = cookies['__session'];

    if (sessionId === '') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 'SESSION_NOT_FOUND', message: 'No session' }));
      return;
    }

    try {
      const session = sessionService.extend(sessionId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ newExpiresAt: session.expiresAt }));
    } catch (err) {
      sendSessionError(res, err);
    }
  }

  return { handleGetInfo, handleExtend };
}

function sendSessionError(res: ServerResponse, err: unknown): void {
  if (err != null && typeof err === 'object' && 'code' in err && 'statusCode' in err) {
    const gatewayErr = err as GatewayError;
    res.writeHead(gatewayErr.statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: gatewayErr.code, message: gatewayErr.message }));
  } else {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 'INTERNAL_ERROR', message: 'Internal error' }));
  }
}
