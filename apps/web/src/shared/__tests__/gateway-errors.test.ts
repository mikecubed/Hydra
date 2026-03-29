/**
 * Tests for browser-side gateway error vocabulary.
 *
 * Validates parsing, classification, and recovery helpers for
 * the structured error responses the gateway sends to the browser.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  type GatewayErrorBody,
  ERROR_CATEGORIES,
  parseGatewayError,
  isAuthError,
  isSessionError,
  isValidationError,
  isDaemonError,
  isRateLimitError,
  isStaleRevision,
  isDaemonUnavailable,
  isWorkflowConflict,
  isRetriable,
  requiresReauth,
  humanMessage,
  getRetryAfterMs,
} from '../gateway-errors.ts';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const authError: GatewayErrorBody = {
  ok: false,
  code: 'INVALID_CREDENTIALS',
  category: 'auth',
  message: 'Invalid credentials',
};

const sessionExpiredError: GatewayErrorBody = {
  ok: false,
  code: 'SESSION_EXPIRED',
  category: 'session',
  message: 'Session has expired',
};

const idleTimeoutError: GatewayErrorBody = {
  ok: false,
  code: 'IDLE_TIMEOUT',
  category: 'session',
  message: 'Session timed out due to inactivity',
};

const rateLimitError: GatewayErrorBody = {
  ok: false,
  code: 'RATE_LIMITED',
  category: 'rate-limit',
  message: 'Too many attempts',
  retryAfterMs: 30_000,
};

const daemonError: GatewayErrorBody = {
  ok: false,
  code: 'DAEMON_UNREACHABLE',
  category: 'daemon',
  message: 'Hydra daemon is unreachable',
};

const validationError: GatewayErrorBody = {
  ok: false,
  code: 'VALIDATION_FAILED',
  category: 'validation',
  message: 'Request validation failed',
};

const sessionNotIdleError: GatewayErrorBody = {
  ok: false,
  code: 'SESSION_NOT_IDLE',
  category: 'session',
  message: 'Session is not idle',
};

const staleApprovalError: GatewayErrorBody = {
  ok: false,
  code: 'STALE_APPROVAL',
  category: 'session',
  message: 'Approval request is stale',
};

const archivedConversationError: GatewayErrorBody = {
  ok: false,
  code: 'CONVERSATION_ARCHIVED',
  category: 'session',
  message: 'Conversation is archived',
};

const staleRevisionError: GatewayErrorBody = {
  ok: false,
  code: 'STALE_REVISION',
  category: 'stale-revision',
  message: 'Config has changed — reload and retry',
};

const daemonUnavailableError: GatewayErrorBody = {
  ok: false,
  code: 'DAEMON_UNAVAILABLE',
  category: 'daemon-unavailable',
  message: 'Daemon unreachable',
};

const workflowConflictError: GatewayErrorBody = {
  ok: false,
  code: 'WORKFLOW_CONFLICT',
  category: 'workflow-conflict',
  message: 'Workflow already running',
};

const errorWithContext: GatewayErrorBody = {
  ok: false,
  code: 'CONVERSATION_NOT_FOUND',
  category: 'validation',
  message: 'Conversation not found',
  conversationId: 'conv-123',
};

// ─── ERROR_CATEGORIES constant ──────────────────────────────────────────────

describe('ERROR_CATEGORIES', () => {
  it('contains exactly the eight gateway error categories', () => {
    assert.deepStrictEqual(ERROR_CATEGORIES, [
      'auth',
      'session',
      'validation',
      'daemon',
      'rate-limit',
      'stale-revision',
      'daemon-unavailable',
      'workflow-conflict',
    ]);
  });

  it('is frozen', () => {
    assert.ok(Object.isFrozen(ERROR_CATEGORIES));
  });
});

// ─── parseGatewayError ──────────────────────────────────────────────────────

describe('parseGatewayError', () => {
  it('parses a valid auth error body', () => {
    const raw = { ok: false, code: 'INVALID_CREDENTIALS', category: 'auth', message: 'Bad creds' };
    const result = parseGatewayError(raw);
    assert.ok(result !== null);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'INVALID_CREDENTIALS');
    assert.equal(result.category, 'auth');
    assert.equal(result.message, 'Bad creds');
  });

  it('parses a body with optional fields', () => {
    const raw = {
      ok: false,
      code: 'TURN_NOT_FOUND',
      category: 'validation',
      message: 'Turn not found',
      conversationId: 'c1',
      turnId: 't1',
      retryAfterMs: 5000,
      httpStatus: 404,
    };
    const result = parseGatewayError(raw);
    assert.ok(result !== null);
    assert.equal(result.conversationId, 'c1');
    assert.equal(result.turnId, 't1');
    assert.equal(result.retryAfterMs, 5000);
    assert.equal(result.httpStatus, 404);
  });

  it('returns null for non-object input', () => {
    assert.equal(parseGatewayError(null), null);
    // eslint-disable-next-line unicorn/no-useless-undefined -- explicitly testing undefined input
    assert.equal(parseGatewayError(undefined), null);
    assert.equal(parseGatewayError('string'), null);
    assert.equal(parseGatewayError(42), null);
  });

  it('returns null when ok is not false', () => {
    assert.equal(parseGatewayError({ ok: true, code: 'X', category: 'auth', message: 'M' }), null);
  });

  it('returns null when required fields are missing', () => {
    assert.equal(parseGatewayError({ ok: false }), null);
    assert.equal(parseGatewayError({ ok: false, code: 'X' }), null);
    assert.equal(parseGatewayError({ ok: false, code: 'X', category: 'auth' }), null);
  });

  it('returns null when category is not a known ErrorCategory', () => {
    assert.equal(
      parseGatewayError({ ok: false, code: 'X', category: 'unknown', message: 'M' }),
      null,
    );
  });

  it('accepts all eight categories', () => {
    for (const cat of ERROR_CATEGORIES) {
      const result = parseGatewayError({ ok: false, code: 'TEST', category: cat, message: 'M' });
      assert.ok(result !== null, `should accept category '${cat}'`);
      assert.equal(result.category, cat);
    }
  });

  // ── optional field validation ─────────────────────────────────────────────

  it('ignores empty-string conversationId', () => {
    const raw = { ok: false, code: 'X', category: 'auth', message: 'M', conversationId: '' };
    const result = parseGatewayError(raw);
    assert.ok(result !== null);
    assert.equal(result.conversationId, undefined);
  });

  it('ignores whitespace-only conversationId', () => {
    const raw = { ok: false, code: 'X', category: 'auth', message: 'M', conversationId: '   ' };
    const result = parseGatewayError(raw);
    assert.ok(result !== null);
    assert.equal(result.conversationId, undefined);
  });

  it('ignores empty-string turnId', () => {
    const raw = { ok: false, code: 'X', category: 'auth', message: 'M', turnId: '' };
    const result = parseGatewayError(raw);
    assert.ok(result !== null);
    assert.equal(result.turnId, undefined);
  });

  it('ignores whitespace-only turnId', () => {
    const raw = { ok: false, code: 'X', category: 'auth', message: 'M', turnId: '  \t ' };
    const result = parseGatewayError(raw);
    assert.ok(result !== null);
    assert.equal(result.turnId, undefined);
  });

  it('ignores NaN retryAfterMs', () => {
    const raw = {
      ok: false,
      code: 'X',
      category: 'auth',
      message: 'M',
      retryAfterMs: Number.NaN,
    };
    const result = parseGatewayError(raw);
    assert.ok(result !== null);
    assert.equal(result.retryAfterMs, undefined);
  });

  it('ignores Infinity retryAfterMs', () => {
    const raw = { ok: false, code: 'X', category: 'auth', message: 'M', retryAfterMs: Infinity };
    const result = parseGatewayError(raw);
    assert.ok(result !== null);
    assert.equal(result.retryAfterMs, undefined);
  });

  it('ignores negative retryAfterMs', () => {
    const raw = { ok: false, code: 'X', category: 'auth', message: 'M', retryAfterMs: -1 };
    const result = parseGatewayError(raw);
    assert.ok(result !== null);
    assert.equal(result.retryAfterMs, undefined);
  });

  it('ignores non-integer retryAfterMs', () => {
    const raw = { ok: false, code: 'X', category: 'auth', message: 'M', retryAfterMs: 3.14 };
    const result = parseGatewayError(raw);
    assert.ok(result !== null);
    assert.equal(result.retryAfterMs, undefined);
  });

  it('accepts zero retryAfterMs', () => {
    const raw = { ok: false, code: 'X', category: 'auth', message: 'M', retryAfterMs: 0 };
    const result = parseGatewayError(raw);
    assert.ok(result !== null);
    assert.equal(result.retryAfterMs, 0);
  });

  it('ignores NaN httpStatus', () => {
    const raw = {
      ok: false,
      code: 'X',
      category: 'auth',
      message: 'M',
      httpStatus: Number.NaN,
    };
    const result = parseGatewayError(raw);
    assert.ok(result !== null);
    assert.equal(result.httpStatus, undefined);
  });

  it('ignores Infinity httpStatus', () => {
    const raw = { ok: false, code: 'X', category: 'auth', message: 'M', httpStatus: Infinity };
    const result = parseGatewayError(raw);
    assert.ok(result !== null);
    assert.equal(result.httpStatus, undefined);
  });

  it('ignores non-integer httpStatus', () => {
    const raw = { ok: false, code: 'X', category: 'auth', message: 'M', httpStatus: 404.5 };
    const result = parseGatewayError(raw);
    assert.ok(result !== null);
    assert.equal(result.httpStatus, undefined);
  });

  it('ignores out-of-range httpStatus (below 100)', () => {
    const raw = { ok: false, code: 'X', category: 'auth', message: 'M', httpStatus: 99 };
    const result = parseGatewayError(raw);
    assert.ok(result !== null);
    assert.equal(result.httpStatus, undefined);
  });

  it('ignores out-of-range httpStatus (above 599)', () => {
    const raw = { ok: false, code: 'X', category: 'auth', message: 'M', httpStatus: 600 };
    const result = parseGatewayError(raw);
    assert.ok(result !== null);
    assert.equal(result.httpStatus, undefined);
  });

  it('accepts valid httpStatus boundaries', () => {
    for (const status of [100, 200, 404, 500, 599]) {
      const raw = { ok: false, code: 'X', category: 'auth', message: 'M', httpStatus: status };
      const result = parseGatewayError(raw);
      assert.ok(result !== null, `should accept httpStatus ${status}`);
      assert.equal(result.httpStatus, status);
    }
  });
});

// ─── Category predicates ────────────────────────────────────────────────────

describe('category predicates', () => {
  it('isAuthError returns true only for auth category', () => {
    assert.ok(isAuthError(authError));
    assert.ok(!isAuthError(sessionExpiredError));
    assert.ok(!isAuthError(validationError));
  });

  it('isSessionError returns true only for session category', () => {
    assert.ok(isSessionError(sessionExpiredError));
    assert.ok(!isSessionError(authError));
  });

  it('isValidationError returns true only for validation category', () => {
    assert.ok(isValidationError(validationError));
    assert.ok(isValidationError(errorWithContext));
    assert.ok(!isValidationError(daemonError));
  });

  it('isDaemonError returns true only for daemon category', () => {
    assert.ok(isDaemonError(daemonError));
    assert.ok(!isDaemonError(authError));
  });

  it('isRateLimitError returns true only for rate-limit category', () => {
    assert.ok(isRateLimitError(rateLimitError));
    assert.ok(!isRateLimitError(authError));
  });

  it('isStaleRevision returns true only for stale-revision category', () => {
    assert.ok(isStaleRevision(staleRevisionError));
    assert.ok(!isStaleRevision(authError));
  });

  it('isDaemonUnavailable returns true only for daemon-unavailable category', () => {
    assert.ok(isDaemonUnavailable(daemonUnavailableError));
    assert.ok(!isDaemonUnavailable(daemonError));
  });

  it('isWorkflowConflict returns true only for workflow-conflict category', () => {
    assert.ok(isWorkflowConflict(workflowConflictError));
    assert.ok(!isWorkflowConflict(authError));
  });
});

// ─── isRetriable ────────────────────────────────────────────────────────────

describe('isRetriable', () => {
  it('rate-limit errors are retriable', () => {
    assert.ok(isRetriable(rateLimitError));
  });

  it('daemon errors are retriable', () => {
    assert.ok(isRetriable(daemonError));
  });

  it('daemon-unavailable errors are retriable', () => {
    assert.ok(isRetriable(daemonUnavailableError));
  });

  it('auth errors are not retriable', () => {
    assert.ok(!isRetriable(authError));
  });

  it('session errors are not retriable', () => {
    assert.ok(!isRetriable(sessionExpiredError));
  });

  it('validation errors are not retriable', () => {
    assert.ok(!isRetriable(validationError));
  });

  it('stale-revision errors are not retriable', () => {
    assert.ok(!isRetriable(staleRevisionError));
  });

  it('workflow-conflict errors are not retriable', () => {
    assert.ok(!isRetriable(workflowConflictError));
  });
});

// ─── requiresReauth ─────────────────────────────────────────────────────────

describe('requiresReauth', () => {
  it('auth errors require re-authentication', () => {
    assert.ok(requiresReauth(authError));
  });

  it('session expired errors require re-authentication', () => {
    assert.ok(requiresReauth(sessionExpiredError));
  });

  it('idle timeout errors require re-authentication', () => {
    assert.ok(requiresReauth(idleTimeoutError));
  });

  it('SESSION_NOT_IDLE does not require re-authentication', () => {
    assert.ok(!requiresReauth(sessionNotIdleError));
  });

  it('session business-rule errors do not require re-authentication', () => {
    assert.ok(!requiresReauth(staleApprovalError));
    assert.ok(!requiresReauth(archivedConversationError));
  });

  it('unknown session-category conflicts do not require re-authentication by default', () => {
    assert.ok(
      !requiresReauth({
        ok: false,
        code: 'APPROVAL_ALREADY_RESPONDED',
        category: 'session',
        message: 'Approval already responded',
      }),
    );
  });

  it('daemon errors do not require re-authentication', () => {
    assert.ok(!requiresReauth(daemonError));
  });

  it('validation errors do not require re-authentication', () => {
    assert.ok(!requiresReauth(validationError));
  });

  it('rate-limit errors do not require re-authentication', () => {
    assert.ok(!requiresReauth(rateLimitError));
  });
});

// ─── humanMessage ───────────────────────────────────────────────────────────

describe('humanMessage', () => {
  it('returns the error message', () => {
    assert.equal(humanMessage(authError), 'Invalid credentials');
  });

  it('returns the message for errors with context fields', () => {
    assert.equal(humanMessage(errorWithContext), 'Conversation not found');
  });
});

// ─── getRetryAfterMs ────────────────────────────────────────────────────────

describe('getRetryAfterMs', () => {
  it('returns retryAfterMs when present', () => {
    assert.equal(getRetryAfterMs(rateLimitError), 30_000);
  });

  it('returns undefined when not present', () => {
    assert.equal(getRetryAfterMs(authError), undefined);
  });

  it('returns undefined for zero', () => {
    const err: GatewayErrorBody = { ...rateLimitError, retryAfterMs: 0 };
    assert.equal(getRetryAfterMs(err), undefined);
  });
});
