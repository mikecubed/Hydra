/**
 * Typed error codes for auth, session, and system failures.
 *
 * Used across auth/, session/, security/, and conversation/ modules.
 */

import type { ErrorCategory } from './gateway-error-response.ts';

export type AuthErrorCode = 'INVALID_CREDENTIALS' | 'RATE_LIMITED' | 'ACCOUNT_DISABLED';

export type SessionErrorCode =
  | 'SESSION_EXPIRED'
  | 'SESSION_INVALIDATED'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_NOT_IDLE'
  | 'IDLE_TIMEOUT';

export type ConversationErrorCode =
  | 'CONVERSATION_NOT_FOUND'
  | 'TURN_NOT_FOUND'
  | 'VALIDATION_FAILED'
  | 'WS_INVALID_MESSAGE'
  | 'WS_BUFFER_OVERFLOW';

export type SystemErrorCode =
  | 'BAD_REQUEST'
  | 'INTERNAL_ERROR'
  | 'DAEMON_UNREACHABLE'
  | 'CLOCK_UNRELIABLE'
  | 'CSRF_INVALID'
  | 'ORIGIN_REJECTED';

export type ErrorCode = AuthErrorCode | SessionErrorCode | ConversationErrorCode | SystemErrorCode;

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
  BAD_REQUEST: 400,
  INTERNAL_ERROR: 500,
  DAEMON_UNREACHABLE: 503,
  CLOCK_UNRELIABLE: 503,
  CSRF_INVALID: 403,
  ORIGIN_REJECTED: 403,
  CONVERSATION_NOT_FOUND: 404,
  TURN_NOT_FOUND: 404,
  VALIDATION_FAILED: 400,
  WS_INVALID_MESSAGE: 400,
  WS_BUFFER_OVERFLOW: 503,
};

/** Map every ErrorCode to its ErrorCategory for structured responses. */
export const ERROR_CATEGORY_MAP: Record<ErrorCode, ErrorCategory> = {
  INVALID_CREDENTIALS: 'auth',
  RATE_LIMITED: 'rate-limit',
  ACCOUNT_DISABLED: 'auth',
  SESSION_EXPIRED: 'session',
  SESSION_INVALIDATED: 'session',
  SESSION_NOT_FOUND: 'auth',
  SESSION_NOT_IDLE: 'session',
  IDLE_TIMEOUT: 'session',
  BAD_REQUEST: 'validation',
  INTERNAL_ERROR: 'daemon',
  DAEMON_UNREACHABLE: 'daemon',
  CLOCK_UNRELIABLE: 'daemon',
  CSRF_INVALID: 'validation',
  ORIGIN_REJECTED: 'auth',
  CONVERSATION_NOT_FOUND: 'validation',
  TURN_NOT_FOUND: 'validation',
  VALIDATION_FAILED: 'validation',
  WS_INVALID_MESSAGE: 'validation',
  WS_BUFFER_OVERFLOW: 'daemon',
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
    BAD_REQUEST: 'Bad request',
    INTERNAL_ERROR: 'Internal error',
    DAEMON_UNREACHABLE: 'Hydra daemon is unreachable',
    CLOCK_UNRELIABLE: 'System clock is unreliable',
    CSRF_INVALID: 'CSRF token missing or invalid',
    ORIGIN_REJECTED: 'Origin not allowed',
    CONVERSATION_NOT_FOUND: 'Conversation not found',
    TURN_NOT_FOUND: 'Turn not found',
    VALIDATION_FAILED: 'Request validation failed',
    WS_INVALID_MESSAGE: 'Invalid WebSocket message',
    WS_BUFFER_OVERFLOW: 'Event buffer overflow',
  };
  return new GatewayError(code, message ?? defaultMessages[code], ERROR_STATUS_MAP[code]);
}
