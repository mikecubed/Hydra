/**
 * Browser-side gateway error vocabulary.
 *
 * Provides typed parsing, classification, and recovery helpers for the
 * structured error responses the gateway sends over WebSocket and
 * conversation-scoped REST endpoints (those returning `{ ok, code,
 * category, message }`).
 *
 * Auth/session REST routes that return a simpler `{ code, message }`
 * shape without `ok` or `category` are NOT covered by this parser —
 * handle those at the HTTP layer before reaching this module.
 *
 * This module mirrors the gateway's GatewayErrorResponse shape without
 * importing from apps/web-gateway/ (boundary rule). The five error
 * categories align with the gateway's ErrorCategory.
 */

// ─── Error Categories ───────────────────────────────────────────────────────

/** The five gateway error categories (FR-027). */
export type ErrorCategory = 'auth' | 'session' | 'validation' | 'daemon' | 'rate-limit';

/** Ordered, frozen list of all valid error categories. */
export const ERROR_CATEGORIES: readonly ErrorCategory[] = Object.freeze([
  'auth',
  'session',
  'validation',
  'daemon',
  'rate-limit',
] as const);

const CATEGORY_SET: ReadonlySet<string> = new Set(ERROR_CATEGORIES);

// ─── GatewayErrorBody ───────────────────────────────────────────────────────

/**
 * Browser-side representation of the gateway's structured error response.
 * Mirrors the wire shape without depending on gateway internals.
 */
export interface GatewayErrorBody {
  readonly ok: false;
  readonly code: string;
  readonly category: ErrorCategory;
  readonly message: string;
  readonly conversationId?: string;
  readonly turnId?: string;
  readonly retryAfterMs?: number;
  readonly httpStatus?: number;
}

// ─── Parsing ────────────────────────────────────────────────────────────────

/** Type guard for non-null, non-array objects. */
function isRecord(raw: unknown): raw is Record<string, unknown> {
  return raw !== null && raw !== undefined && typeof raw === 'object' && !Array.isArray(raw);
}

/** Validate the required fields of a gateway error body. */
function hasRequiredFields(
  obj: Record<string, unknown>,
): obj is Record<string, unknown> & { code: string; category: string; message: string } {
  return (
    obj['ok'] === false &&
    typeof obj['code'] === 'string' &&
    obj['code'] !== '' &&
    typeof obj['category'] === 'string' &&
    CATEGORY_SET.has(obj['category']) &&
    typeof obj['message'] === 'string' &&
    obj['message'] !== ''
  );
}

/**
 * Parse an unknown value into a typed GatewayErrorBody.
 * Returns null if the shape does not match expectations.
 */
export function parseGatewayError(raw: unknown): GatewayErrorBody | null {
  if (!isRecord(raw) || !hasRequiredFields(raw)) return null;

  return {
    ok: false,
    code: raw['code'],
    category: raw['category'] as ErrorCategory,
    message: raw['message'],
    ...(typeof raw['conversationId'] === 'string' && { conversationId: raw['conversationId'] }),
    ...(typeof raw['turnId'] === 'string' && { turnId: raw['turnId'] }),
    ...(typeof raw['retryAfterMs'] === 'number' && { retryAfterMs: raw['retryAfterMs'] }),
    ...(typeof raw['httpStatus'] === 'number' && { httpStatus: raw['httpStatus'] }),
  };
}

// ─── Category predicates ────────────────────────────────────────────────────

export function isAuthError(err: GatewayErrorBody): boolean {
  return err.category === 'auth';
}

export function isSessionError(err: GatewayErrorBody): boolean {
  return err.category === 'session';
}

export function isValidationError(err: GatewayErrorBody): boolean {
  return err.category === 'validation';
}

export function isDaemonError(err: GatewayErrorBody): boolean {
  return err.category === 'daemon';
}

export function isRateLimitError(err: GatewayErrorBody): boolean {
  return err.category === 'rate-limit';
}

// ─── Recovery helpers ───────────────────────────────────────────────────────

/**
 * Session error codes that do NOT indicate credential loss.
 * These errors mean the session exists and is valid but cannot accept
 * the request for an operational reason (e.g. another turn is in progress).
 */
const NON_REAUTH_SESSION_CODES: ReadonlySet<string> = new Set(['SESSION_NOT_IDLE']);

/** Whether the error suggests the request may succeed if retried later. */
export function isRetriable(err: GatewayErrorBody): boolean {
  return err.category === 'rate-limit' || err.category === 'daemon';
}

/**
 * Whether the error requires the operator to re-authenticate.
 *
 * All `auth` errors require reauth.  `session` errors require reauth
 * unless the specific error code indicates the session is still valid
 * but temporarily unavailable (e.g. SESSION_NOT_IDLE).
 */
export function requiresReauth(err: GatewayErrorBody): boolean {
  if (err.category === 'auth') return true;
  if (err.category === 'session') return !NON_REAUTH_SESSION_CODES.has(err.code);
  return false;
}

/** The operator-facing error message. */
export function humanMessage(err: GatewayErrorBody): string {
  return err.message;
}

/** Extract retryAfterMs if present and positive; otherwise undefined. */
export function getRetryAfterMs(err: GatewayErrorBody): number | undefined {
  return err.retryAfterMs != null && err.retryAfterMs > 0 ? err.retryAfterMs : undefined;
}
