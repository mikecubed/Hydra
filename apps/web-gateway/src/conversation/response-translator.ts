/**
 * Translate daemon HTTP responses into GatewayErrorResponse (FR-028).
 *
 * Maps daemon error codes from @hydra/web-contracts ErrorResponse to
 * the gateway's five-category error shape. Also handles fetch-level
 * failures (network errors, timeouts) as daemon-unreachable.
 */
import type { ErrorCategory, GatewayErrorResponse } from '../shared/gateway-error-response.ts';
import { createGatewayErrorResponse } from '../shared/gateway-error-response.ts';

/**
 * Maps every daemon ErrorCode to a gateway ErrorCategory.
 * Codes not in this map default to 'daemon'.
 */
export const DAEMON_ERROR_CATEGORY_MAP: Record<string, ErrorCategory> = {
  NOT_FOUND: 'validation',
  INVALID_INPUT: 'validation',
  TURN_NOT_TERMINAL: 'validation',
  TURN_NOT_ACTIVE: 'validation',
  CONFLICT: 'session',
  ARCHIVED: 'session',
  STALE_APPROVAL: 'session',
  APPROVAL_ALREADY_RESPONDED: 'session',
  QUEUE_FULL: 'rate-limit',
  INTERNAL_ERROR: 'daemon',
};

/** Structured contract error body: { ok:false, error:<ErrorCode>, message }. */
interface ContractErrorBody {
  ok: false;
  error: string;
  message: string;
  conversationId?: string;
  turnId?: string;
}

/** Current daemon sendError body: { ok:false, error:<message>, details }. */
interface DaemonSendErrorBody {
  ok: false;
  error: string;
  details?: unknown;
}

/** Daemon ApprovalResult failure: { success:false, reason, approval, conflictNotification? }. */
interface ApprovalFailureBody {
  success: false;
  reason: string;
  approval: Record<string, unknown>;
  conflictNotification?: { message: string };
}

/**
 * Maps daemon ApprovalResult.reason values to stable gateway codes and categories.
 * Reasons not in this map fall back to a generic APPROVAL_FAILURE code.
 */
export const APPROVAL_REASON_MAP: Record<string, { code: string; category: ErrorCategory }> = {
  invalid_response: { code: 'APPROVAL_INVALID_RESPONSE', category: 'validation' },
  terminal_turn: { code: 'APPROVAL_TERMINAL_TURN', category: 'validation' },
  already_responded: { code: 'APPROVAL_ALREADY_RESPONDED', category: 'session' },
  stale: { code: 'APPROVAL_STALE', category: 'session' },
  expired: { code: 'APPROVAL_EXPIRED', category: 'session' },
};

function isContractErrorBody(body: unknown): body is ContractErrorBody {
  if (typeof body !== 'object' || body === null) return false;
  const candidate = body as Record<string, unknown>;
  return (
    candidate['ok'] === false &&
    typeof candidate['error'] === 'string' &&
    typeof candidate['message'] === 'string'
  );
}

function isDaemonSendErrorBody(body: unknown): body is DaemonSendErrorBody {
  if (typeof body !== 'object' || body === null) return false;
  const candidate = body as Record<string, unknown>;
  return (
    candidate['ok'] === false && typeof candidate['error'] === 'string' && !('message' in candidate)
  );
}

/**
 * Known daemon sendError() message+status → stable gateway code mappings.
 *
 * The daemon's current sendError() puts the human-readable message in the
 * `error` field (not a machine code). This table maps exact message+status
 * combinations to stable gateway codes so downstream browser code can
 * distinguish different failure modes without parsing message text.
 *
 * Key format: `${status}:${exactMessage}`
 */
export const SEND_ERROR_KNOWN: ReadonlyMap<string, { code: string; category: ErrorCategory }> =
  new Map([
    // ── 404 resource-not-found ──
    ['404:Conversation not found', { code: 'CONVERSATION_NOT_FOUND', category: 'validation' }],
    ['404:Turn not found', { code: 'TURN_NOT_FOUND', category: 'validation' }],
    ['404:Fork point turn not found', { code: 'FORK_POINT_NOT_FOUND', category: 'validation' }],
    ['404:Artifact not found', { code: 'ARTIFACT_NOT_FOUND', category: 'validation' }],
    ['404:Approval not found', { code: 'APPROVAL_NOT_FOUND', category: 'validation' }],
    // ── 400 business-rule ──
    ['400:Conversation is archived', { code: 'CONVERSATION_ARCHIVED', category: 'session' }],
    // ── 401 auth ──
    ['401:X-Session-Id header is required', { code: 'SESSION_NOT_FOUND', category: 'auth' }],
  ]);

/**
 * Pattern-based fallbacks for daemon sendError() messages that follow a
 * recognizable shape but aren't exact-matched above. Checked in order;
 * first match wins.
 */
export const SEND_ERROR_PATTERNS: ReadonlyArray<{
  status: number;
  test: (msg: string) => boolean;
  code: string;
  category: ErrorCategory;
}> = [
  // "instruction is required", "response is required", "forkPointTurnId is required"
  {
    status: 400,
    test: (m) => m.endsWith(' is required'),
    code: 'VALIDATION_FAILED',
    category: 'validation',
  },
  // "Turn does not belong to this conversation", "Fork point turn does not belong to …"
  {
    status: 400,
    test: (m) => m.includes('does not belong to'),
    code: 'VALIDATION_FAILED',
    category: 'validation',
  },
  // "Invalid status filter: …", "Invalid limit: …", "Invalid lastAcknowledgedSeq: …"
  {
    status: 400,
    test: (m) => m.startsWith('Invalid '),
    code: 'VALIDATION_FAILED',
    category: 'validation',
  },
];

function isApprovalFailureBody(body: unknown): body is ApprovalFailureBody {
  if (typeof body !== 'object' || body === null) return false;
  const candidate = body as Record<string, unknown>;
  return (
    candidate['success'] === false &&
    typeof candidate['reason'] === 'string' &&
    typeof candidate['approval'] === 'object' &&
    candidate['approval'] !== null
  );
}

/** Infer category from HTTP status when no structured body is available. */
function categoryFromStatus(status: number): ErrorCategory {
  if (status === 401 || status === 403) return 'auth';
  if (status === 409 || status === 410) return 'session';
  if (status === 429) return 'rate-limit';
  if (status === 503 || status === 504) return 'daemon-unavailable';
  if (status >= 400 && status < 500) return 'validation';
  return 'daemon';
}

/** Generic message for 5xx responses — never leaks internal daemon details to the browser. */
const SANITIZED_5XX_MESSAGE = 'Internal daemon error';

/** Default retryAfterMs for categories that support automatic client retry. */
const DEFAULT_RETRY_AFTER_MS: Partial<Record<ErrorCategory, number>> = {
  'rate-limit': 5000,
  'daemon-unavailable': 2000,
};

function createGenericStatusError(status: number, message: string): GatewayErrorResponse {
  const category = categoryFromStatus(status);
  const codeMap: Record<string, string> = {
    auth: 'INVALID_CREDENTIALS',
    session: 'SESSION_EXPIRED',
    validation: 'BAD_REQUEST',
    'rate-limit': 'RATE_LIMITED',
    daemon: 'INTERNAL_ERROR',
    'daemon-unavailable': 'DAEMON_UNREACHABLE',
    'stale-revision': 'STALE_REVISION',
    'workflow-conflict': 'WORKFLOW_CONFLICT',
  };

  return createGatewayErrorResponse({
    code: codeMap[category] ?? 'INTERNAL_ERROR',
    category,
    message: status >= 500 ? SANITIZED_5XX_MESSAGE : message,
    httpStatus: status,
    retryAfterMs: DEFAULT_RETRY_AFTER_MS[category],
  });
}

function translateApprovalFailure(status: number, body: ApprovalFailureBody): GatewayErrorResponse {
  const mapping = APPROVAL_REASON_MAP[body.reason] as
    | { code: string; category: ErrorCategory }
    | undefined;
  const code = mapping?.code ?? 'APPROVAL_FAILURE';
  const category = mapping?.category ?? categoryFromStatus(status);
  const message =
    body.conflictNotification?.message ?? `Approval rejected: ${body.reason.replaceAll('_', ' ')}`;
  return createGatewayErrorResponse({ code, category, message, httpStatus: status });
}

function translateSendErrorBody(status: number, body: DaemonSendErrorBody): GatewayErrorResponse {
  const exactKey = `${String(status)}:${body.error}`;
  const exact = SEND_ERROR_KNOWN.get(exactKey);
  if (exact) {
    return createGatewayErrorResponse({
      code: exact.code,
      category: exact.category,
      message: body.error,
      httpStatus: status,
    });
  }

  for (const pattern of SEND_ERROR_PATTERNS) {
    if (status === pattern.status && pattern.test(body.error)) {
      return createGatewayErrorResponse({
        code: pattern.code,
        category: pattern.category,
        message: body.error,
        httpStatus: status,
      });
    }
  }

  return createGenericStatusError(status, body.error);
}

/**
 * Translate a daemon HTTP response (status + parsed body) into a GatewayErrorResponse.
 *
 * When body is a valid daemon ErrorResponse, the daemon error code is mapped
 * to a gateway category. When body is null/invalid, category is inferred from
 * the HTTP status code.
 */
export function translateDaemonResponse(status: number, body: unknown): GatewayErrorResponse {
  if (isContractErrorBody(body)) {
    const category = DAEMON_ERROR_CATEGORY_MAP[body.error] ?? 'daemon';
    return createGatewayErrorResponse({
      code: body.error,
      category,
      message: status >= 500 ? SANITIZED_5XX_MESSAGE : body.message,
      conversationId: body.conversationId,
      turnId: body.turnId,
      httpStatus: status,
      retryAfterMs: DEFAULT_RETRY_AFTER_MS[category],
    });
  }

  if (isApprovalFailureBody(body)) {
    return translateApprovalFailure(status, body);
  }

  if (isDaemonSendErrorBody(body)) {
    return translateSendErrorBody(status, body);
  }

  return createGenericStatusError(status, `Daemon returned HTTP ${String(status)}`);
}

/**
 * Translate a fetch-level failure (network error, timeout, abort)
 * into a GatewayErrorResponse with category 'daemon-unavailable'.
 *
 * Timeout/abort errors receive a distinct DAEMON_TIMEOUT code and a
 * retryAfterMs hint so the browser can distinguish transient timeouts
 * from sustained outages (FD-2 drill matrix).
 *
 * Raw error messages are never echoed — they may contain internal
 * network details (hostnames, IPs, ports) that must not reach clients.
 */
export function translateFetchFailure(error: unknown): GatewayErrorResponse {
  const isAbort = error instanceof Error && error.name === 'AbortError';

  if (isAbort) {
    return createGatewayErrorResponse({
      code: 'DAEMON_TIMEOUT',
      category: 'daemon-unavailable',
      message: 'Daemon request timed out',
      retryAfterMs: 2000,
    });
  }

  return createGatewayErrorResponse({
    code: 'DAEMON_UNREACHABLE',
    category: 'daemon-unavailable',
    message: 'Daemon unreachable',
  });
}
