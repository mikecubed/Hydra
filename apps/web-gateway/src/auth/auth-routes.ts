/**
 * Auth routes — POST /login, POST /logout, POST /reauth.
 *
 * Sets __session cookie (HttpOnly; SameSite=Strict; Secure if TLS)
 * and __csrf cookie (non-HttpOnly for JS double-submit). (FR-020, FR-022)
 */
import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AuthService } from './auth-service.ts';
import type { SessionService } from '../session/session-service.ts';
import type { GatewayError } from '../shared/errors.ts';
import type { GatewayEnv } from '../shared/types.ts';

export interface AuthRoutesConfig {
  secureCookies: boolean;
}

export function createAuthRoutes(
  authService: AuthService,
  sessionService: SessionService,
  config: AuthRoutesConfig = { secureCookies: false },
): Hono<GatewayEnv> {
  const app = new Hono<GatewayEnv>();

  app.post('/login', async (c) => {
    let body: { identity?: string; secret?: string };
    try {
      body = await c.req.json<{ identity?: string; secret?: string }>();
    } catch {
      return c.json({ code: 'BAD_REQUEST', message: 'Invalid JSON body' }, 400);
    }
    const identity = body.identity ?? '';
    const secret = body.secret ?? '';

    if (identity === '' || secret === '') {
      return c.json(
        { code: 'BAD_REQUEST', message: 'Missing identity or secret' },
        400,
      );
    }

    try {
      const { session } = await authService.authenticate(
        identity,
        secret,
        c.req.header('x-forwarded-for') ?? 'unknown',
      );

      setCookie(c, '__session', session.id, {
        httpOnly: true,
        sameSite: 'Strict',
        secure: config.secureCookies,
        path: '/',
      });
      setCookie(c, '__csrf', session.csrfToken, {
        httpOnly: false,
        sameSite: 'Strict',
        secure: config.secureCookies,
        path: '/',
      });

      return c.json({
        operatorId: session.operatorId,
        expiresAt: session.expiresAt,
        state: session.state,
      });
    } catch (err) {
      return handleAuthError(c, err);
    }
  });

  app.post('/logout', async (c) => {
    const sessionId = getCookie(c, '__session');

    if (sessionId) {
      try {
        // sessionService.logout() silently handles benign cases (session not
        // found, already terminal). Only genuine failures (e.g. audit
        // persistence errors) will throw, and those must surface as 5xx.
        await sessionService.logout(sessionId);
      } catch {
        // logout() rolls server state back on audit failure — the session
        // is still active, so keep cookies intact so the client can retry.
        return c.json({ code: 'INTERNAL_ERROR', message: 'Internal error' }, 500);
      }
    }

    // Only clear cookies after a confirmed server-side terminal transition
    // (or when there was no session to begin with).
    deleteCookie(c, '__session', { path: '/' });
    deleteCookie(c, '__csrf', { path: '/' });

    return c.json({ success: true });
  });

  app.post('/reauth', async (c) => {
    const sessionId = getCookie(c, '__session');
    if (!sessionId) {
      return c.json(
        { code: 'SESSION_NOT_FOUND', message: 'No session' },
        401,
      );
    }

    let body: { identity?: string; secret?: string };
    try {
      body = await c.req.json<{ identity?: string; secret?: string }>();
    } catch {
      return c.json({ code: 'BAD_REQUEST', message: 'Invalid JSON body' }, 400);
    }
    const identity = body.identity ?? '';
    const secret = body.secret ?? '';

    if (identity === '' || secret === '') {
      return c.json({ code: 'BAD_REQUEST', message: 'Missing credentials' }, 400);
    }

    try {
      const session = await authService.reauthenticate(
        identity,
        secret,
        c.req.header('x-forwarded-for') ?? 'unknown',
        sessionId,
      );

      return c.json({
        operatorId: session.operatorId,
        state: session.state,
        expiresAt: session.expiresAt,
        lastActivityAt: session.lastActivityAt,
        createdAt: session.createdAt,
      });
    } catch (err) {
      return handleAuthError(c, err);
    }
  });

  return app;
}

function handleAuthError(c: Context, err: unknown): Response {
  if (err != null && typeof err === 'object' && 'code' in err && 'statusCode' in err) {
    const gatewayErr = err as GatewayError;
    return c.json(
      { code: gatewayErr.code, message: gatewayErr.message },
      gatewayErr.statusCode as ContentfulStatusCode,
    );
  }
  return c.json({ code: 'INTERNAL_ERROR', message: 'Internal error' }, 500);
}
