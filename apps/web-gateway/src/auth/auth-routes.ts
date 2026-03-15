/**
 * Auth routes — POST /auth/login, POST /auth/logout, POST /auth/reauth.
 *
 * Sets __session cookie (HttpOnly; SameSite=Strict; Secure if TLS)
 * and __csrf cookie (non-HttpOnly for JS double-submit). (FR-020, FR-022)
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthService } from './auth-service.ts';
import type { SessionService } from '../session/session-service.ts';
import { parseCookies } from '../shared/cookies.ts';
import type { AuthenticatedRequest } from './auth-middleware.ts';
import type { GatewayError } from '../shared/errors.ts';

export interface AuthRoutesConfig {
  secureCookies: boolean;
}

export function createAuthRoutes(
  authService: AuthService,
  sessionService: SessionService,
  config: AuthRoutesConfig = { secureCookies: false },
): {
  handleLogin: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  handleLogout: (req: AuthenticatedRequest, res: ServerResponse) => void;
  handleReauth: (req: AuthenticatedRequest, res: ServerResponse) => Promise<void>;
} {
  async function handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    const { identity, secret } = body;

    if (identity === '' || secret === '') {
      sendError(res, 400, 'Missing identity or secret');
      return;
    }

    try {
      const { session } = await authService.authenticate(
        identity,
        secret,
        req.socket.remoteAddress ?? 'unknown',
      );
      sendLoginResponse(res, session, config);
    } catch (err) {
      handleAuthError(res, err);
    }
  }

  function handleLogout(req: AuthenticatedRequest, res: ServerResponse): void {
    const sessionId = parseCookies(req.headers.cookie)['__session'];
    if (sessionId !== '') {
      try {
        sessionService.logout(sessionId);
      } catch {
        // Session may already be gone
      }
    }
    sendLogoutResponse(res, config);
  }

  async function handleReauth(req: AuthenticatedRequest, res: ServerResponse): Promise<void> {
    const sessionId = parseCookies(req.headers.cookie)['__session'];
    if (sessionId === '') {
      sendError(res, 401, 'No session');
      return;
    }

    const body = await readBody(req);
    const { identity, secret } = body;

    if (identity === '' || secret === '') {
      sendError(res, 400, 'Missing credentials');
      return;
    }

    try {
      const session = await authService.reauthenticate(
        identity,
        secret,
        req.socket.remoteAddress ?? 'unknown',
        sessionId,
      );
      sendReauthResponse(res, session);
    } catch (err) {
      handleAuthError(res, err);
    }
  }

  return { handleLogin, handleLogout, handleReauth };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sendError(res: ServerResponse, statusCode: number, message: string): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ code: 'BAD_REQUEST', message }));
}

function sendLogoutResponse(res: ServerResponse, config: AuthRoutesConfig): void {
  const clearSession = buildCookie('__session', '', {
    httpOnly: true,
    sameSite: 'Strict',
    secure: config.secureCookies,
    path: '/',
    maxAge: 0,
  });
  const clearCsrf = buildCookie('__csrf', '', {
    httpOnly: false,
    sameSite: 'Strict',
    secure: config.secureCookies,
    path: '/',
    maxAge: 0,
  });

  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Set-Cookie': [clearSession, clearCsrf],
  });
  res.end(JSON.stringify({ success: true }));
}

interface CookieOptions {
  httpOnly: boolean;
  sameSite: string;
  secure: boolean;
  path: string;
  maxAge?: number;
}

function buildCookie(name: string, value: string, opts: CookieOptions): string {
  let cookie = `${name}=${value}; Path=${opts.path}; SameSite=${opts.sameSite}`;
  if (opts.httpOnly) cookie += '; HttpOnly';
  if (opts.secure) cookie += '; Secure';
  if (opts.maxAge !== undefined) cookie += `; Max-Age=${String(opts.maxAge)}`;
  return cookie;
}

function readBody(req: IncomingMessage): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, string>);
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

function sendLoginResponse(
  res: ServerResponse,
  session: { id: string; csrfToken: string; operatorId: string; expiresAt: string; state: string },
  config: AuthRoutesConfig,
): void {
  const sessionCookie = buildCookie('__session', session.id, {
    httpOnly: true,
    sameSite: 'Strict',
    secure: config.secureCookies,
    path: '/',
  });

  const csrfCookie = buildCookie('__csrf', session.csrfToken, {
    httpOnly: false,
    sameSite: 'Strict',
    secure: config.secureCookies,
    path: '/',
  });

  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Set-Cookie': [sessionCookie, csrfCookie],
  });
  res.end(
    JSON.stringify({
      operatorId: session.operatorId,
      expiresAt: session.expiresAt,
      state: session.state,
    }),
  );
}

function sendReauthResponse(
  res: ServerResponse,
  session: {
    operatorId: string;
    state: string;
    expiresAt: string;
    lastActivityAt: string;
    createdAt: string;
  },
): void {
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
}

function handleAuthError(res: ServerResponse, err: unknown): void {
  if (err != null && typeof err === 'object' && 'code' in err && 'statusCode' in err) {
    const gatewayErr = err as GatewayError;
    res.writeHead(gatewayErr.statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: gatewayErr.code, message: gatewayErr.message }));
  } else {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 'INTERNAL_ERROR', message: 'Internal error' }));
  }
}
