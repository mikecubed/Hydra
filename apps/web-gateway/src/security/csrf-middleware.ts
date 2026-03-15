/**
 * CSRF middleware — double-submit cookie validation.
 * Reads __csrf cookie, compares to X-CSRF-Token header on mutating routes. (FR-022)
 */
import type { ServerResponse } from 'node:http';
import { parseCookies } from '../shared/cookies.ts';
import { createError } from '../shared/errors.ts';
import type { AuthenticatedRequest } from '../auth/auth-middleware.ts';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function createCsrfMiddleware(): (
  req: AuthenticatedRequest,
  res: ServerResponse,
  next: () => void,
) => void {
  return function csrfMiddleware(
    req: AuthenticatedRequest,
    res: ServerResponse,
    next: () => void,
  ): void {
    const method = req.method?.toUpperCase() ?? 'GET';
    if (SAFE_METHODS.has(method)) {
      next();
      return;
    }

    const cookies = parseCookies(req.headers.cookie);
    const cookieToken = cookies['__csrf'];
    const headerToken = req.headers['x-csrf-token'] as string | undefined;

    if (
      cookieToken === '' ||
      headerToken === '' ||
      headerToken === undefined ||
      cookieToken !== headerToken
    ) {
      const err = createError('CSRF_INVALID');
      res.writeHead(err.statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: err.code, message: err.message }));
      return;
    }

    next();
  };
}
