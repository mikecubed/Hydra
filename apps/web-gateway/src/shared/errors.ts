/**
 * Typed error codes for auth, session, and system failures.
 *
 * Used across auth/, session/, and security/ modules.
 */

export type AuthErrorCode = 'INVALID_CREDENTIALS' | 'RATE_LIMITED' | 'ACCOUNT_DISABLED';

export type SessionErrorCode =
  | 'SESSION_EXPIRED'
  | 'SESSION_INVALIDATED'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_NOT_IDLE'
  | 'IDLE_TIMEOUT';

export type SystemErrorCode =
  | 'DAEMON_UNREACHABLE'
  | 'CLOCK_UNRELIABLE'
  | 'CSRF_INVALID'
  | 'ORIGIN_REJECTED';

export type ErrorCode = AuthErrorCode | SessionErrorCode | SystemErrorCode;

export class GatewayError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;

  constructor(code: ErrorCode, message: string, statusCode = 401) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export const ERROR_STATUS_MAP: Record<ErrorCode, number> = {
  INVALID_CREDENTIALS: 401,
  RATE_LIMITED: 429,
  ACCOUNT_DISABLED: 403,
  SESSION_EXPIRED: 401,
  SESSION_INVALIDATED: 401,
  SESSION_NOT_FOUND: 401,
  SESSION_NOT_IDLE: 403,
  IDLE_TIMEOUT: 401,
  DAEMON_UNREACHABLE: 503,
  CLOCK_UNRELIABLE: 503,
  CSRF_INVALID: 403,
  ORIGIN_REJECTED: 403,
};

export function createError(code: ErrorCode, message?: string): GatewayError {
  const defaultMessages: Record<ErrorCode, string> = {
    INVALID_CREDENTIALS: 'Invalid credentials',
    RATE_LIMITED: 'Too many attempts. Please try again later.',
    ACCOUNT_DISABLED: 'Account is disabled',
    SESSION_EXPIRED: 'Session has expired',
    SESSION_INVALIDATED: 'Session has been invalidated',
    SESSION_NOT_FOUND: 'No valid session found',
    SESSION_NOT_IDLE: 'Re-authentication is only allowed for idle sessions',
    IDLE_TIMEOUT: 'Session idle timeout — re-authentication required',
    DAEMON_UNREACHABLE: 'Hydra daemon is unreachable',
    CLOCK_UNRELIABLE: 'System clock is unreliable',
    CSRF_INVALID: 'CSRF token missing or invalid',
    ORIGIN_REJECTED: 'Origin not allowed',
  };
  return new GatewayError(code, message ?? defaultMessages[code], ERROR_STATUS_MAP[code]);
}
