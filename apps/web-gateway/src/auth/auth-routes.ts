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

type CredentialResult =
  | { ok: true; identity: string; secret: string }
  | { ok: false; response: Response };

async function parseCredentials(
  c: Context,
  missingMessage = 'Missing identity or secret',
): Promise<CredentialResult> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return {
      ok: false,
      response: c.json({ code: 'BAD_REQUEST', message: 'Invalid JSON body' }, 400),
    };
  }
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      response: c.json({ code: 'BAD_REQUEST', message: 'Invalid JSON body' }, 400),
    };
  }
  const body = raw as Record<string, unknown>;
  const { identity, secret } = body as { identity: unknown; secret: unknown };
  if (
    typeof identity !== 'string' ||
    typeof secret !== 'string' ||
    identity === '' ||
    secret === ''
  ) {
    return { ok: false, response: c.json({ code: 'BAD_REQUEST', message: missingMessage }, 400) };
  }
  return { ok: true, identity, secret };
}

function setSessionCookies(
  c: Context,
  session: { id: string; csrfToken: string },
  config: AuthRoutesConfig,
): void {
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
}

export function createAuthRoutes(
  authService: AuthService,
  sessionService: SessionService,
  config: AuthRoutesConfig = { secureCookies: false },
): Hono<GatewayEnv> {
  const app = new Hono<GatewayEnv>();

  app.post('/login', async (c) => {
    const creds = await parseCredentials(c);
    if (!creds.ok) return creds.response;

    try {
      const sourceKey = c.get('sourceKey');
      const { session } = await authService.authenticate(creds.identity, creds.secret, sourceKey);
      setSessionCookies(c, session, config);

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

    if (sessionId != null && sessionId !== '') {
      try {
        await sessionService.logout(sessionId);
      } catch {
        // logout() rolls server state back on audit failure — the session
        // is still active, so keep cookies intact so the client can retry.
        return c.json({ code: 'INTERNAL_ERROR', message: 'Internal error' }, 500);
      }
    }

    deleteCookie(c, '__session', { path: '/' });
    deleteCookie(c, '__csrf', { path: '/' });

    return c.json({ success: true });
  });

  app.post('/reauth', async (c) => {
    const sessionId = getCookie(c, '__session');
    if (sessionId == null || sessionId === '') {
      return c.json({ code: 'SESSION_NOT_FOUND', message: 'No session' }, 401);
    }

    const creds = await parseCredentials(c, 'Missing credentials');
    if (!creds.ok) return creds.response;

    try {
      const sourceKey = c.get('sourceKey');
      const session = await authService.reauthenticate(
        creds.identity,
        creds.secret,
        sourceKey,
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
