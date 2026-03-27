/**
 * Auth API client — browser-side fetch wrappers for login, session info, and logout.
 *
 * All calls use `credentials: 'include'` so the gateway's HttpOnly session
 * cookie is sent automatically. Session IDs never touch JS (FR-020).
 */
import type {
  LoginResponse as LoginResponseType,
  SessionInfo as SessionInfoType,
} from '@hydra/web-contracts';
import { LoginResponse, SessionInfo, AuthError } from '@hydra/web-contracts';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Read the `__csrf` double-submit cookie value set by the gateway. */
function getCsrfToken(): string {
  const cookieString = (globalThis as { document?: { cookie: string } }).document?.cookie ?? '';
  const match = cookieString.split(';').find((c) => c.trim().startsWith('__csrf='));
  if (match === undefined) return '';
  const rawValue = match.trim().slice('__csrf='.length).trim();
  if (rawValue === '') return '';
  try {
    return decodeURIComponent(rawValue);
  } catch {
    return '';
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Authenticate an operator. Sends identity + secret to the gateway which
 * sets an HttpOnly session cookie on success.
 */
export async function login(identity: string, secret: string): Promise<LoginResponseType> {
  const res = await fetch('/auth/login', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity, secret }),
  });

  if (!res.ok) {
    const body: unknown = await res.json();
    const parsed = AuthError.parse(body);
    const err = new Error(parsed.message) as Error & { code: string };
    err.code = parsed.code;
    throw err;
  }

  const body: unknown = await res.json();
  return LoginResponse.parse(body);
}

/**
 * Fetch the current session info. Returns `null` when the session is
 * expired or missing (401).
 */
export async function getSessionInfo(): Promise<SessionInfoType | null> {
  const res = await fetch('/session/info', {
    credentials: 'include',
  });

  if (res.status === 401) return null;

  if (!res.ok) {
    throw new Error(`/session/info returned ${res.status.toString()}`);
  }

  const body: unknown = await res.json();
  return SessionInfo.parse(body);
}

/**
 * Log out the current operator. Reads the CSRF cookie and sends it as a
 * header for the double-submit check. Swallows all errors so callers can
 * fire-and-forget.
 */
export async function logout(): Promise<void> {
  try {
    await fetch('/auth/logout', {
      method: 'POST',
      credentials: 'include',
      headers: { 'x-csrf-token': getCsrfToken() },
    });
  } catch {
    // Swallow — logout is best-effort.
  }
}
