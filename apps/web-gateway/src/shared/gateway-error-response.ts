/**
 * Gateway-internal structured error response shape (FR-026, FR-027).
 *
 * Five error categories distinguish failure modes for the browser.
 * This shape is used for both REST JSON error bodies and WebSocket error frames.
 * It is gateway-internal — not exported via @hydra/web-contracts.
 */

/** The eight gateway error categories per FR-027. */
export type ErrorCategory =
  | 'auth'
  | 'session'
  | 'validation'
  | 'daemon'
  | 'rate-limit'
  | 'stale-revision'
  | 'daemon-unavailable'
  | 'workflow-conflict';

/** Ordered list of all valid categories (useful for exhaustiveness checks). */
export const ERROR_CATEGORIES: readonly ErrorCategory[] = [
  'auth',
  'session',
  'validation',
  'daemon',
  'rate-limit',
  'stale-revision',
  'daemon-unavailable',
  'workflow-conflict',
] as const;

/** Structured error response for all gateway error surfaces. */
export interface GatewayErrorResponse {
  readonly ok: false;
  readonly code: string;
  readonly category: ErrorCategory;
  readonly message: string;
  readonly conversationId?: string;
  readonly turnId?: string;
  readonly retryAfterMs?: number;
  /** Original daemon HTTP status when available — lets the route layer preserve it. */
  readonly httpStatus?: number;
}

/** Options for creating a GatewayErrorResponse (ok: false is added automatically). */
export interface GatewayErrorResponseOptions {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly message: string;
  readonly conversationId?: string;
  readonly turnId?: string;
  readonly retryAfterMs?: number;
  /** Original daemon HTTP status — threaded through for the route layer. */
  readonly httpStatus?: number;
}

/** Create a GatewayErrorResponse with ok: false always set. */
export function createGatewayErrorResponse(
  opts: GatewayErrorResponseOptions,
): GatewayErrorResponse {
  const response: GatewayErrorResponse = {
    ok: false,
    code: opts.code,
    category: opts.category,
    message: opts.message,
    ...(opts.conversationId !== undefined && { conversationId: opts.conversationId }),
    ...(opts.turnId !== undefined && { turnId: opts.turnId }),
    ...(opts.retryAfterMs !== undefined && { retryAfterMs: opts.retryAfterMs }),
    ...(opts.httpStatus !== undefined && { httpStatus: opts.httpStatus }),
  };
  return response;
}
