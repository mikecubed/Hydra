/**
 * Failure-drill coverage (T015).
 *
 * Validates gateway error classification and runtime failure translation
 * against the failure-drill matrix in docs/web-interface/05-security-and-quality.md.
 *
 * Drill scenarios covered:
 *   FD-2  Daemon unreachable (transient timeout vs sustained outage)
 *   FD-3  Reconnect buffer miss / exhaustion
 *   FD-4  Protected mutation rejection
 *   FD-5  Operations data error
 *   FD-7  Rate-limit with retryAfterMs
 *   Cross-cutting: retryable category classification
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ERROR_CATEGORIES,
  isRetryableCategory,
} from '../shared/gateway-error-response.ts';
import {
  ERROR_STATUS_MAP,
  ERROR_CATEGORY_MAP,
  createError,
  type ErrorCode,
} from '../shared/errors.ts';
import {
  translateDaemonResponse,
  translateFetchFailure,
} from '../conversation/response-translator.ts';
import { translateMutationError } from '../mutations/response-translator.ts';
import {
  translateOperationsDaemonResponse,
  translateOperationsFetchFailure,
} from '../operations/response-translator.ts';

// ─── FD-2: Daemon unreachable ────────────────────────────────────────────────

describe('FD-2: Daemon unreachable classification', () => {
  it('DAEMON_UNREACHABLE error code maps to daemon-unavailable category', () => {
    assert.equal(ERROR_CATEGORY_MAP['DAEMON_UNREACHABLE'], 'daemon-unavailable');
  });

  it('DAEMON_TIMEOUT error code exists and maps to daemon-unavailable', () => {
    assert.equal(ERROR_CATEGORY_MAP['DAEMON_TIMEOUT'], 'daemon-unavailable');
    assert.equal(ERROR_STATUS_MAP['DAEMON_TIMEOUT'], 504);
  });

  it('createError produces a GatewayError for DAEMON_TIMEOUT', () => {
    const err = createError('DAEMON_TIMEOUT');
    assert.equal(err.code, 'DAEMON_TIMEOUT');
    assert.equal(err.statusCode, 504);
    assert.ok(err.message.length > 0);
  });

  it('translateFetchFailure: network error → DAEMON_UNREACHABLE, daemon-unavailable', () => {
    const err = new TypeError('fetch failed: connect ECONNREFUSED 127.0.0.1:4173');
    const result = translateFetchFailure(err);
    assert.equal(result.code, 'DAEMON_UNREACHABLE');
    assert.equal(result.category, 'daemon-unavailable');
    assert.ok(!result.message.includes('ECONNREFUSED'), 'must not leak raw error details');
  });

  it('translateFetchFailure: timeout → DAEMON_TIMEOUT, daemon-unavailable, retryAfterMs', () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    const result = translateFetchFailure(err);
    assert.equal(result.code, 'DAEMON_TIMEOUT');
    assert.equal(result.category, 'daemon-unavailable');
    assert.equal(typeof result.retryAfterMs, 'number');
    assert.ok((result.retryAfterMs ?? 0) > 0, 'timeout should hint retry delay');
  });

  it('503 status maps to daemon-unavailable in response translation', () => {
    const result = translateDaemonResponse(503, null);
    assert.equal(result.category, 'daemon-unavailable');
    assert.equal(result.code, 'DAEMON_UNREACHABLE');
  });

  it('502 status maps to daemon category (generic upstream error)', () => {
    const result = translateDaemonResponse(502, null);
    assert.equal(result.category, 'daemon');
    assert.equal(result.code, 'INTERNAL_ERROR');
  });

  it('generic 5xx with sendError body: 500 → daemon/INTERNAL_ERROR', () => {
    const result = translateDaemonResponse(500, { ok: false, error: 'Internal explosion' });
    assert.equal(result.category, 'daemon');
    assert.equal(result.code, 'INTERNAL_ERROR');
    assert.equal(result.message, 'Internal daemon error');
  });

  it('503 with sendError body → daemon-unavailable/DAEMON_UNREACHABLE', () => {
    const result = translateDaemonResponse(503, { ok: false, error: 'upstream timeout' });
    assert.equal(result.category, 'daemon-unavailable');
    assert.equal(result.code, 'DAEMON_UNREACHABLE');
    assert.equal(result.message, 'Internal daemon error');
  });
});

// ─── FD-3: Reconnect buffer miss / exhaustion ───────────────────────────────

describe('FD-3: Reconnect buffer miss and exhaustion', () => {
  it('WS_BUFFER_OVERFLOW maps to daemon category and 503 status', () => {
    assert.equal(ERROR_CATEGORY_MAP['WS_BUFFER_OVERFLOW'], 'daemon');
    assert.equal(ERROR_STATUS_MAP['WS_BUFFER_OVERFLOW'], 503);
  });

  it('WS_INVALID_MESSAGE maps to validation category and 400 status', () => {
    assert.equal(ERROR_CATEGORY_MAP['WS_INVALID_MESSAGE'], 'validation');
    assert.equal(ERROR_STATUS_MAP['WS_INVALID_MESSAGE'], 400);
  });

  it('all transport error codes are present in both ERROR_STATUS_MAP and ERROR_CATEGORY_MAP', () => {
    const transportCodes: ErrorCode[] = ['WS_BUFFER_OVERFLOW', 'WS_INVALID_MESSAGE'];
    for (const code of transportCodes) {
      assert.ok(code in ERROR_STATUS_MAP, `${code} missing from ERROR_STATUS_MAP`);
      assert.ok(code in ERROR_CATEGORY_MAP, `${code} missing from ERROR_CATEGORY_MAP`);
    }
  });
});

// ─── FD-4: Protected mutation rejection ─────────────────────────────────────

describe('FD-4: Protected mutation rejection', () => {
  it('stale-revision → 409 with STALE_REVISION code', () => {
    const result = translateMutationError('stale-revision');
    assert.equal(result.status, 409);
    assert.equal(result.code, 'STALE_REVISION');
    assert.ok(result.message.toLowerCase().includes('reload') || result.message.includes('retry'));
  });

  it('workflow-conflict → 409 with WORKFLOW_CONFLICT code', () => {
    const result = translateMutationError('workflow-conflict');
    assert.equal(result.status, 409);
    assert.equal(result.code, 'WORKFLOW_CONFLICT');
  });

  it('daemon-unavailable → 503 with DAEMON_UNAVAILABLE code', () => {
    const result = translateMutationError('daemon-unavailable');
    assert.equal(result.status, 503);
    assert.equal(result.code, 'DAEMON_UNAVAILABLE');
  });

  it('rate-limit → 429 with RATE_LIMITED code', () => {
    const result = translateMutationError('rate-limit');
    assert.equal(result.status, 429);
    assert.equal(result.code, 'RATE_LIMITED');
  });

  it('every ErrorCategory is handled by translateMutationError (exhaustive)', () => {
    for (const category of ERROR_CATEGORIES) {
      const result = translateMutationError(category);
      assert.equal(typeof result.status, 'number', `${category} must return a status`);
      assert.ok(result.code.length > 0, `${category} must return a code`);
      assert.ok(result.message.length > 0, `${category} must return a message`);
    }
  });
});

// ─── FD-5: Operations data error ────────────────────────────────────────────

describe('FD-5: Operations data error classification', () => {
  it('CONTROL_REVISION_STALE → session category', () => {
    const body = { ok: false, error: 'REVISION_STALE', message: 'Revision is stale' };
    const result = translateOperationsDaemonResponse(409, body);
    assert.equal(result.category, 'session');
    assert.equal(result.code, 'CONTROL_REVISION_STALE');
  });

  it('CONTROL_REVISION_SUPERSEDED → session category', () => {
    const body = { ok: false, error: 'REVISION_SUPERSEDED', message: 'Revision superseded' };
    const result = translateOperationsDaemonResponse(409, body);
    assert.equal(result.category, 'session');
    assert.equal(result.code, 'CONTROL_REVISION_SUPERSEDED');
  });

  it('CONTROL_REJECTED → validation category', () => {
    const body = { ok: false, error: 'CONTROL_REJECTED', message: 'Control rejected' };
    const result = translateOperationsDaemonResponse(400, body);
    assert.equal(result.category, 'validation');
    assert.equal(result.code, 'CONTROL_REJECTED');
  });

  it('CONTROL_AUTHORITY_DENIED → auth category', () => {
    const body = { ok: false, error: 'AUTHORITY_DENIED', message: 'Authority denied' };
    const result = translateOperationsDaemonResponse(403, body);
    assert.equal(result.category, 'auth');
    assert.equal(result.code, 'CONTROL_AUTHORITY_DENIED');
  });

  it('operations fetch failure maps to daemon-unavailable', () => {
    const err = new TypeError('fetch failed');
    const result = translateOperationsFetchFailure(err);
    assert.equal(result.category, 'daemon-unavailable');
    assert.equal(result.code, 'DAEMON_UNREACHABLE');
  });

  it('operations daemon 503 maps to daemon-unavailable', () => {
    const result = translateOperationsDaemonResponse(503, null);
    assert.equal(result.category, 'daemon-unavailable');
  });
});

// ─── FD-7: Rate-limit retryAfterMs ─────────────────────────────────────────

describe('FD-7: Rate-limit with retryAfterMs', () => {
  it('RATE_LIMITED error code maps to rate-limit category', () => {
    assert.equal(ERROR_CATEGORY_MAP['RATE_LIMITED'], 'rate-limit');
  });

  it('RATE_LIMITED maps to 429 status', () => {
    assert.equal(ERROR_STATUS_MAP['RATE_LIMITED'], 429);
  });

  it('daemon 429 without body → rate-limit category', () => {
    const result = translateDaemonResponse(429, null);
    assert.equal(result.category, 'rate-limit');
    assert.equal(result.code, 'RATE_LIMITED');
  });

  it('daemon QUEUE_FULL → rate-limit category with retryAfterMs', () => {
    const body = { ok: false, error: 'QUEUE_FULL', message: 'Instruction queue is full' };
    const result = translateDaemonResponse(429, body);
    assert.equal(result.category, 'rate-limit');
    assert.equal(typeof result.retryAfterMs, 'number');
    assert.ok((result.retryAfterMs ?? 0) > 0, 'rate-limit should include retry hint');
  });

  it('generic 429 response includes retryAfterMs', () => {
    const result = translateDaemonResponse(429, null);
    assert.equal(typeof result.retryAfterMs, 'number');
    assert.ok((result.retryAfterMs ?? 0) > 0, 'generic 429 should include retry hint');
  });

  it('gateway-generated RATE_LIMITED errors include retryAfterMs', () => {
    const result = createError('RATE_LIMITED');
    assert.equal(typeof result.retryAfterMs, 'number');
    assert.ok((result.retryAfterMs ?? 0) > 0, 'gateway rate-limit should include retry hint');
  });
});

// ─── Cross-cutting: retryable classification ────────────────────────────────

describe('Retryable category classification', () => {
  it('daemon-unavailable is retryable', () => {
    assert.equal(isRetryableCategory('daemon-unavailable'), true);
  });

  it('rate-limit is retryable', () => {
    assert.equal(isRetryableCategory('rate-limit'), true);
  });

  it('auth is not retryable', () => {
    assert.equal(isRetryableCategory('auth'), false);
  });

  it('session is not retryable', () => {
    assert.equal(isRetryableCategory('session'), false);
  });

  it('validation is not retryable', () => {
    assert.equal(isRetryableCategory('validation'), false);
  });

  it('daemon is not retryable', () => {
    assert.equal(isRetryableCategory('daemon'), false);
  });

  it('stale-revision is not retryable', () => {
    assert.equal(isRetryableCategory('stale-revision'), false);
  });

  it('workflow-conflict is not retryable', () => {
    assert.equal(isRetryableCategory('workflow-conflict'), false);
  });

  it('classifies every ErrorCategory (exhaustive)', () => {
    for (const category of ERROR_CATEGORIES) {
      const result = isRetryableCategory(category);
      assert.equal(typeof result, 'boolean', `${category} must return a boolean`);
    }
  });
});
