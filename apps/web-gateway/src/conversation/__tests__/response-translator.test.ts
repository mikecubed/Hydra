import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  translateDaemonResponse,
  translateFetchFailure,
  DAEMON_ERROR_CATEGORY_MAP,
  APPROVAL_REASON_MAP,
  SEND_ERROR_KNOWN,
} from '../response-translator.ts';

// The daemon ErrorResponse shape from @hydra/web-contracts
interface DaemonErrorResponse {
  ok: false;
  error: string;
  message: string;
  conversationId?: string;
  turnId?: string;
}

function makeDaemonError(
  error: string,
  message: string,
  extras?: { conversationId?: string; turnId?: string },
): DaemonErrorResponse {
  return { ok: false, error, message, ...extras };
}

function makeApprovalFailure(reason: string, conflictNotification?: { message: string }) {
  return {
    success: false as const,
    reason,
    approval: { id: 'apr-test', turnId: 'turn-test', status: 'pending' },
    ...(conflictNotification !== undefined && { conflictNotification }),
  };
}

describe('DAEMON_ERROR_CATEGORY_MAP', () => {
  it('maps every daemon ErrorCode to a gateway category', () => {
    const daemonCodes = [
      'NOT_FOUND',
      'INVALID_INPUT',
      'CONFLICT',
      'ARCHIVED',
      'STALE_APPROVAL',
      'APPROVAL_ALREADY_RESPONDED',
      'TURN_NOT_TERMINAL',
      'TURN_NOT_ACTIVE',
      'QUEUE_FULL',
      'INTERNAL_ERROR',
    ];
    for (const code of daemonCodes) {
      assert.ok(code in DAEMON_ERROR_CATEGORY_MAP, `Missing mapping for daemon code: ${code}`);
    }
  });
});

describe('APPROVAL_REASON_MAP', () => {
  it('maps every known daemon ApprovalResult.reason to a gateway code and category', () => {
    const knownReasons = [
      'invalid_response',
      'terminal_turn',
      'already_responded',
      'stale',
      'expired',
    ];
    for (const reason of knownReasons) {
      assert.ok(reason in APPROVAL_REASON_MAP, `Missing mapping for approval reason: ${reason}`);
      assert.ok(APPROVAL_REASON_MAP[reason].code, `Missing code for reason: ${reason}`);
      assert.ok(APPROVAL_REASON_MAP[reason].category, `Missing category for reason: ${reason}`);
    }
  });
});

describe('translateDaemonResponse', () => {
  it('translates NOT_FOUND into validation category', () => {
    const body = makeDaemonError('NOT_FOUND', 'Conversation not found', {
      conversationId: 'conv-1',
    });
    const result = translateDaemonResponse(404, body);
    assert.equal(result.ok, false);
    assert.equal(result.category, 'validation');
    assert.equal(result.code, 'NOT_FOUND');
    assert.equal(result.conversationId, 'conv-1');
  });

  it('translates INVALID_INPUT into validation category', () => {
    const body = makeDaemonError('INVALID_INPUT', 'Bad field');
    const result = translateDaemonResponse(400, body);
    assert.equal(result.category, 'validation');
    assert.equal(result.code, 'INVALID_INPUT');
  });

  it('preserves daemon HTTP status in httpStatus field (Issue 2 regression)', () => {
    const body = makeDaemonError('INVALID_INPUT', 'Bad field');
    const result = translateDaemonResponse(400, body);
    assert.equal(result.httpStatus, 400, 'httpStatus must carry the original daemon status');
  });

  it('preserves 404 httpStatus for NOT_FOUND errors', () => {
    const body = makeDaemonError('NOT_FOUND', 'Conversation not found');
    const result = translateDaemonResponse(404, body);
    assert.equal(result.httpStatus, 404);
  });

  it('preserves 400 httpStatus for approval invalid_response failure', () => {
    const body = makeApprovalFailure('invalid_response');
    const result = translateDaemonResponse(400, body);
    assert.equal(result.httpStatus, 400, 'approval invalid_response must stay 400');
  });

  it('translates CONFLICT into session category', () => {
    const body = makeDaemonError('CONFLICT', 'Concurrent modification');
    const result = translateDaemonResponse(409, body);
    assert.equal(result.category, 'session');
    assert.equal(result.code, 'CONFLICT');
  });

  it('translates ARCHIVED into session category', () => {
    const body = makeDaemonError('ARCHIVED', 'Conversation is archived');
    const result = translateDaemonResponse(410, body);
    assert.equal(result.category, 'session');
    assert.equal(result.code, 'ARCHIVED');
  });

  it('translates STALE_APPROVAL into session category', () => {
    const body = makeDaemonError('STALE_APPROVAL', 'Approval is stale');
    const result = translateDaemonResponse(409, body);
    assert.equal(result.category, 'session');
  });

  it('translates APPROVAL_ALREADY_RESPONDED into session category', () => {
    const body = makeDaemonError('APPROVAL_ALREADY_RESPONDED', 'Already responded');
    const result = translateDaemonResponse(409, body);
    assert.equal(result.category, 'session');
  });

  it('translates TURN_NOT_TERMINAL into validation category', () => {
    const body = makeDaemonError('TURN_NOT_TERMINAL', 'Turn is still active');
    const result = translateDaemonResponse(400, body);
    assert.equal(result.category, 'validation');
  });

  it('translates TURN_NOT_ACTIVE into validation category', () => {
    const body = makeDaemonError('TURN_NOT_ACTIVE', 'Turn is not active');
    const result = translateDaemonResponse(400, body);
    assert.equal(result.category, 'validation');
  });

  it('translates QUEUE_FULL into rate-limit category', () => {
    const body = makeDaemonError('QUEUE_FULL', 'Instruction queue is full');
    const result = translateDaemonResponse(429, body);
    assert.equal(result.category, 'rate-limit');
  });

  it('translates INTERNAL_ERROR into daemon category', () => {
    const body = makeDaemonError('INTERNAL_ERROR', 'Something broke');
    const result = translateDaemonResponse(500, body);
    assert.equal(result.category, 'daemon');
    assert.equal(result.message, 'Internal daemon error');
  });

  it('preserves non-500 daemon messages in contract error bodies', () => {
    const body = makeDaemonError('INVALID_INPUT', 'Field X is required');
    const result = translateDaemonResponse(400, body);
    assert.equal(result.message, 'Field X is required');
  });

  it('preserves turnId from daemon error body', () => {
    const body = makeDaemonError('NOT_FOUND', 'Turn not found', {
      turnId: 'turn-42',
    });
    const result = translateDaemonResponse(404, body);
    assert.equal(result.turnId, 'turn-42');
  });

  it('handles unknown daemon error code with daemon category', () => {
    const body = { ok: false as const, error: 'UNKNOWN_CODE', message: 'mystery' };
    const result = translateDaemonResponse(500, body);
    assert.equal(result.category, 'daemon');
    assert.equal(result.code, 'UNKNOWN_CODE');
    assert.equal(result.message, 'Internal daemon error');
  });

  it('handles HTTP 5xx without valid error body as daemon error', () => {
    const result = translateDaemonResponse(502, null);
    assert.equal(result.category, 'daemon');
    assert.equal(result.code, 'DAEMON_UNREACHABLE');
    assert.equal(result.message, 'Internal daemon error');
  });

  it('handles HTTP 401 without error body as auth error', () => {
    const result = translateDaemonResponse(401, null);
    assert.equal(result.category, 'auth');
  });

  it('handles HTTP 429 without error body as rate-limit', () => {
    const result = translateDaemonResponse(429, null);
    assert.equal(result.category, 'rate-limit');
  });

  it('handles HTTP 409 without error body as session error', () => {
    const result = translateDaemonResponse(409, null);
    assert.equal(result.category, 'session');
    assert.equal(result.code, 'SESSION_EXPIRED');
    assert.equal(result.httpStatus, 409);
  });

  it('handles HTTP 410 without error body as session error', () => {
    const result = translateDaemonResponse(410, null);
    assert.equal(result.category, 'session');
    assert.equal(result.code, 'SESSION_EXPIRED');
    assert.equal(result.httpStatus, 410);
  });

  // ── Current daemon sendError envelope: { ok:false, error:<message>, details } ──

  it('translates current daemon sendError body (error+details, no message field)', () => {
    const body = { ok: false, error: 'Conversation not found', details: null };
    const result = translateDaemonResponse(404, body);
    assert.equal(result.ok, false);
    assert.equal(result.category, 'validation');
    assert.equal(result.code, 'CONVERSATION_NOT_FOUND');
    assert.equal(result.message, 'Conversation not found');
  });

  it('preserves real daemon message from sendError body rather than generic HTTP fallback', () => {
    const body = { ok: false, error: 'X-Session-Id header is required', details: null };
    const result = translateDaemonResponse(401, body);
    assert.equal(result.message, 'X-Session-Id header is required');
    assert.equal(result.category, 'auth');
    assert.equal(result.code, 'SESSION_NOT_FOUND');
  });

  it('handles daemon sendError with non-null details', () => {
    const body = { ok: false, error: 'response is required', details: { field: 'response' } };
    const result = translateDaemonResponse(400, body);
    assert.equal(result.message, 'response is required');
    assert.equal(result.category, 'validation');
    assert.equal(result.code, 'VALIDATION_FAILED');
  });

  it('prefers structured contract body over sendError shape when both error and message present', () => {
    const body = { ok: false, error: 'NOT_FOUND', message: 'Turn not found', turnId: 'turn-42' };
    const result = translateDaemonResponse(404, body);
    assert.equal(result.code, 'NOT_FOUND');
    assert.equal(result.message, 'Turn not found');
    assert.equal(result.turnId, 'turn-42');
  });

  // ── Daemon ApprovalResult failure envelope: { success:false, reason, approval } ──

  it('translates approval failure reason=invalid_response into APPROVAL_INVALID_RESPONSE / validation', () => {
    const body = makeApprovalFailure('invalid_response');
    const result = translateDaemonResponse(400, body);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'APPROVAL_INVALID_RESPONSE');
    assert.equal(result.category, 'validation');
    assert.ok(result.message.includes('invalid response'));
  });

  it('translates approval failure reason=terminal_turn into APPROVAL_TERMINAL_TURN / validation', () => {
    const body = makeApprovalFailure('terminal_turn');
    const result = translateDaemonResponse(409, body);
    assert.equal(result.code, 'APPROVAL_TERMINAL_TURN');
    assert.equal(result.category, 'validation');
  });

  it('translates approval failure reason=already_responded into APPROVAL_ALREADY_RESPONDED / session', () => {
    const body = makeApprovalFailure('already_responded');
    const result = translateDaemonResponse(409, body);
    assert.equal(result.code, 'APPROVAL_ALREADY_RESPONDED');
    assert.equal(result.category, 'session');
  });

  it('translates approval failure reason=stale into APPROVAL_STALE / session', () => {
    const body = makeApprovalFailure('stale');
    const result = translateDaemonResponse(409, body);
    assert.equal(result.code, 'APPROVAL_STALE');
    assert.equal(result.category, 'session');
  });

  it('translates approval failure reason=expired into APPROVAL_EXPIRED / session', () => {
    const body = makeApprovalFailure('expired');
    const result = translateDaemonResponse(409, body);
    assert.equal(result.code, 'APPROVAL_EXPIRED');
    assert.equal(result.category, 'session');
  });

  it('uses conflictNotification.message when present in approval failure', () => {
    const body = makeApprovalFailure('already_responded', {
      message: 'Approval already responded by another session',
    });
    const result = translateDaemonResponse(409, body);
    assert.equal(result.code, 'APPROVAL_ALREADY_RESPONDED');
    assert.equal(result.message, 'Approval already responded by another session');
  });

  it('does not collapse stale approval to generic BAD_REQUEST fallback', () => {
    const body = makeApprovalFailure('stale');
    const result = translateDaemonResponse(409, body);
    assert.notEqual(result.code, 'BAD_REQUEST');
    assert.notEqual(result.code, 'SESSION_EXPIRED');
    assert.equal(result.code, 'APPROVAL_STALE');
  });

  it('does not collapse already_responded approval to generic BAD_REQUEST fallback', () => {
    const body = makeApprovalFailure('already_responded');
    const result = translateDaemonResponse(409, body);
    assert.notEqual(result.code, 'BAD_REQUEST');
    assert.notEqual(result.code, 'SESSION_EXPIRED');
    assert.equal(result.code, 'APPROVAL_ALREADY_RESPONDED');
  });

  it('falls back gracefully for unknown approval failure reasons', () => {
    const body = {
      success: false,
      reason: 'some_future_reason',
      approval: { id: 'apr-1', turnId: 't-1' },
    };
    const result = translateDaemonResponse(409, body);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'APPROVAL_FAILURE');
    assert.ok(result.message.includes('some future reason'));
  });
});

// ── Regression tests: real daemon sendError() messages → stable gateway codes ──

describe('SEND_ERROR_KNOWN coverage', () => {
  it('maps every entry in SEND_ERROR_KNOWN to a non-empty code and valid category', () => {
    const validCategories = new Set(['auth', 'session', 'validation', 'daemon', 'rate-limit']);
    for (const [key, mapping] of SEND_ERROR_KNOWN) {
      assert.ok(key.includes(':'), `Key must be "status:message": ${key}`);
      assert.ok(mapping.code.length > 0, `Empty code for key: ${key}`);
      assert.ok(validCategories.has(mapping.category), `Invalid category for key: ${key}`);
    }
  });
});

describe('translateDaemonResponse — real daemon sendError() regression', () => {
  // Helper: create a real daemon sendError envelope
  function sendErrorBody(error: string, details: unknown = null) {
    return { ok: false, error, details };
  }

  // ── 404 resource-not-found (the primary blocker) ──

  it('maps "Conversation not found" 404 to CONVERSATION_NOT_FOUND', () => {
    const result = translateDaemonResponse(404, sendErrorBody('Conversation not found'));
    assert.equal(result.code, 'CONVERSATION_NOT_FOUND');
    assert.equal(result.category, 'validation');
    assert.equal(result.message, 'Conversation not found');
    assert.equal(result.httpStatus, 404);
  });

  it('maps "Turn not found" 404 to TURN_NOT_FOUND', () => {
    const result = translateDaemonResponse(404, sendErrorBody('Turn not found'));
    assert.equal(result.code, 'TURN_NOT_FOUND');
    assert.equal(result.category, 'validation');
    assert.equal(result.message, 'Turn not found');
    assert.equal(result.httpStatus, 404);
  });

  it('maps "Fork point turn not found" 404 to FORK_POINT_NOT_FOUND', () => {
    const result = translateDaemonResponse(404, sendErrorBody('Fork point turn not found'));
    assert.equal(result.code, 'FORK_POINT_NOT_FOUND');
    assert.equal(result.category, 'validation');
    assert.equal(result.message, 'Fork point turn not found');
    assert.equal(result.httpStatus, 404);
  });

  it('maps "Artifact not found" 404 to ARTIFACT_NOT_FOUND', () => {
    const result = translateDaemonResponse(404, sendErrorBody('Artifact not found'));
    assert.equal(result.code, 'ARTIFACT_NOT_FOUND');
    assert.equal(result.category, 'validation');
    assert.equal(result.message, 'Artifact not found');
    assert.equal(result.httpStatus, 404);
  });

  it('maps "Approval not found" 404 to APPROVAL_NOT_FOUND', () => {
    const result = translateDaemonResponse(404, sendErrorBody('Approval not found'));
    assert.equal(result.code, 'APPROVAL_NOT_FOUND');
    assert.equal(result.category, 'validation');
    assert.equal(result.message, 'Approval not found');
    assert.equal(result.httpStatus, 404);
  });

  it('does not collapse any known 404 to generic BAD_REQUEST', () => {
    const notFoundMessages = [
      'Conversation not found',
      'Turn not found',
      'Fork point turn not found',
      'Artifact not found',
      'Approval not found',
    ];
    for (const msg of notFoundMessages) {
      const result = translateDaemonResponse(404, sendErrorBody(msg));
      assert.notEqual(result.code, 'BAD_REQUEST', `"${msg}" must not collapse to BAD_REQUEST`);
    }
  });

  // ── 400 business-rule exact match ──

  it('maps "Conversation is archived" 400 to CONVERSATION_ARCHIVED / session', () => {
    const result = translateDaemonResponse(400, sendErrorBody('Conversation is archived'));
    assert.equal(result.code, 'CONVERSATION_ARCHIVED');
    assert.equal(result.category, 'session');
    assert.equal(result.message, 'Conversation is archived');
    assert.equal(result.httpStatus, 400);
  });

  // ── 401 auth exact match ──

  it('maps "X-Session-Id header is required" 401 to SESSION_NOT_FOUND / auth', () => {
    const result = translateDaemonResponse(401, sendErrorBody('X-Session-Id header is required'));
    assert.equal(result.code, 'SESSION_NOT_FOUND');
    assert.equal(result.category, 'auth');
    assert.equal(result.message, 'X-Session-Id header is required');
    assert.equal(result.httpStatus, 401);
  });

  // ── 400 pattern-matched: "X is required" ──

  it('maps "instruction is required" 400 to VALIDATION_FAILED', () => {
    const result = translateDaemonResponse(400, sendErrorBody('instruction is required'));
    assert.equal(result.code, 'VALIDATION_FAILED');
    assert.equal(result.category, 'validation');
    assert.equal(result.message, 'instruction is required');
    assert.equal(result.httpStatus, 400);
  });

  it('maps "response is required" 400 to VALIDATION_FAILED', () => {
    const result = translateDaemonResponse(
      400,
      sendErrorBody('response is required', { field: 'response' }),
    );
    assert.equal(result.code, 'VALIDATION_FAILED');
    assert.equal(result.message, 'response is required');
  });

  it('maps "forkPointTurnId is required" 400 to VALIDATION_FAILED', () => {
    const result = translateDaemonResponse(400, sendErrorBody('forkPointTurnId is required'));
    assert.equal(result.code, 'VALIDATION_FAILED');
    assert.equal(result.message, 'forkPointTurnId is required');
  });

  // ── 400 pattern-matched: "does not belong to" ──

  it('maps "Turn does not belong to this conversation" 400 to VALIDATION_FAILED', () => {
    const result = translateDaemonResponse(
      400,
      sendErrorBody('Turn does not belong to this conversation'),
    );
    assert.equal(result.code, 'VALIDATION_FAILED');
    assert.equal(result.category, 'validation');
    assert.equal(result.message, 'Turn does not belong to this conversation');
  });

  it('maps "Fork point turn does not belong to this conversation" 400 to VALIDATION_FAILED', () => {
    const result = translateDaemonResponse(
      400,
      sendErrorBody('Fork point turn does not belong to this conversation'),
    );
    assert.equal(result.code, 'VALIDATION_FAILED');
    assert.equal(result.message, 'Fork point turn does not belong to this conversation');
  });

  // ── 400 pattern-matched: "Invalid …" ──

  it('maps "Invalid status filter: …" 400 to VALIDATION_FAILED', () => {
    const result = translateDaemonResponse(
      400,
      sendErrorBody('Invalid status filter: "bogus". Must be one of: active, archived'),
    );
    assert.equal(result.code, 'VALIDATION_FAILED');
    assert.equal(
      result.message,
      'Invalid status filter: "bogus". Must be one of: active, archived',
    );
  });

  it('maps "Invalid limit: …" 400 to VALIDATION_FAILED', () => {
    const result = translateDaemonResponse(
      400,
      sendErrorBody('Invalid limit: must be an integer between 1 and 100'),
    );
    assert.equal(result.code, 'VALIDATION_FAILED');
    assert.equal(result.message, 'Invalid limit: must be an integer between 1 and 100');
  });

  it('maps "Invalid lastAcknowledgedSeq: …" 400 to VALIDATION_FAILED', () => {
    const result = translateDaemonResponse(
      400,
      sendErrorBody('Invalid lastAcknowledgedSeq: must be a non-negative integer'),
    );
    assert.equal(result.code, 'VALIDATION_FAILED');
  });

  // ── Generic fallback still works for unrecognized messages ──

  it('falls back to BAD_REQUEST for unknown 400 sendError messages', () => {
    const result = translateDaemonResponse(400, sendErrorBody('Something completely unexpected'));
    assert.equal(result.code, 'BAD_REQUEST');
    assert.equal(result.category, 'validation');
    assert.equal(result.message, 'Something completely unexpected');
  });

  it('falls back to DAEMON_UNREACHABLE for unknown 500 sendError messages', () => {
    const result = translateDaemonResponse(500, sendErrorBody('Internal explosion'));
    assert.equal(result.code, 'DAEMON_UNREACHABLE');
    assert.equal(result.category, 'daemon');
    assert.equal(result.message, 'Internal daemon error');
    assert.equal(result.httpStatus, 500);
  });

  it('sanitizes raw daemon text for 502 sendError bodies', () => {
    const result = translateDaemonResponse(502, sendErrorBody('ECONNREFUSED 127.0.0.1:4173'));
    assert.equal(result.code, 'DAEMON_UNREACHABLE');
    assert.equal(result.category, 'daemon');
    assert.equal(result.message, 'Internal daemon error');
    assert.equal(result.httpStatus, 502);
  });

  it('sanitizes raw daemon text for 503 sendError bodies', () => {
    const result = translateDaemonResponse(503, sendErrorBody('upstream timeout'));
    assert.equal(result.message, 'Internal daemon error');
    assert.equal(result.httpStatus, 503);
  });

  it('preserves httpStatus for all pattern-matched sendError bodies', () => {
    const cases: Array<[number, string]> = [
      [404, 'Conversation not found'],
      [404, 'Turn not found'],
      [400, 'Conversation is archived'],
      [400, 'instruction is required'],
      [401, 'X-Session-Id header is required'],
    ];
    for (const [status, msg] of cases) {
      const result = translateDaemonResponse(status, sendErrorBody(msg));
      assert.equal(result.httpStatus, status, `httpStatus for "${msg}" must be ${String(status)}`);
    }
  });

  it('patterns only match their designated status (400 pattern does not fire on 404)', () => {
    // "instruction is required" pattern only triggers on 400, not 404
    const result = translateDaemonResponse(404, sendErrorBody('instruction is required'));
    assert.notEqual(result.code, 'VALIDATION_FAILED');
    // 404 unknown message falls through to generic validation → BAD_REQUEST
    assert.equal(result.code, 'BAD_REQUEST');
  });
});

describe('translateFetchFailure', () => {
  it('translates TypeError (network error) into daemon-unreachable without raw details', () => {
    const err = new TypeError('fetch failed: connect ECONNREFUSED 127.0.0.1:4173');
    const result = translateFetchFailure(err);
    assert.equal(result.ok, false);
    assert.equal(result.category, 'daemon');
    assert.equal(result.code, 'DAEMON_UNREACHABLE');
    assert.equal(result.message, 'Daemon unreachable');
    assert.ok(!result.message.includes('ECONNREFUSED'), 'must not leak connection details');
    assert.ok(!result.message.includes('127.0.0.1'), 'must not leak IP addresses');
  });

  it('translates AbortError (timeout) into daemon-unreachable', () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    const result = translateFetchFailure(err);
    assert.equal(result.category, 'daemon');
    assert.equal(result.code, 'DAEMON_UNREACHABLE');
    assert.equal(result.message, 'Daemon request timeout or abort');
  });

  it('translates generic Error into daemon category without raw details', () => {
    const err = new Error('getaddrinfo ENOTFOUND internal-host.corp.net');
    const result = translateFetchFailure(err);
    assert.equal(result.category, 'daemon');
    assert.equal(result.code, 'DAEMON_UNREACHABLE');
    assert.equal(result.message, 'Daemon unreachable');
    assert.ok(!result.message.includes('internal-host'), 'must not leak internal hostnames');
  });

  it('translates non-Error values into daemon category', () => {
    const result = translateFetchFailure('random string');
    assert.equal(result.category, 'daemon');
    assert.equal(result.code, 'DAEMON_UNREACHABLE');
    assert.equal(result.message, 'Daemon unreachable');
  });
});
