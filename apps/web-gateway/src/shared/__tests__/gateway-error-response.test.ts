import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { GatewayErrorResponse, ErrorCategory } from '../gateway-error-response.ts';
import { ERROR_CATEGORIES, createGatewayErrorResponse } from '../gateway-error-response.ts';

describe('ErrorCategory', () => {
  it('defines exactly eight categories', () => {
    const expected: ErrorCategory[] = [
      'auth',
      'session',
      'validation',
      'daemon',
      'rate-limit',
      'stale-revision',
      'daemon-unavailable',
      'workflow-conflict',
    ];
    assert.deepStrictEqual([...ERROR_CATEGORIES], expected);
  });
});

describe('GatewayErrorResponse', () => {
  it('has ok: false literal', () => {
    const resp: GatewayErrorResponse = createGatewayErrorResponse({
      code: 'INTERNAL_ERROR',
      category: 'daemon',
      message: 'Something failed',
    });
    assert.equal(resp.ok, false);
  });

  it('includes required fields: code, category, message', () => {
    const resp = createGatewayErrorResponse({
      code: 'CONVERSATION_NOT_FOUND',
      category: 'validation',
      message: 'No such conversation',
    });
    assert.equal(resp.code, 'CONVERSATION_NOT_FOUND');
    assert.equal(resp.category, 'validation');
    assert.equal(resp.message, 'No such conversation');
    assert.equal(resp.ok, false);
  });

  it('supports optional conversationId field', () => {
    const resp = createGatewayErrorResponse({
      code: 'CONVERSATION_NOT_FOUND',
      category: 'validation',
      message: 'Not found',
      conversationId: 'conv-123',
    });
    assert.equal(resp.conversationId, 'conv-123');
  });

  it('supports optional turnId field', () => {
    const resp = createGatewayErrorResponse({
      code: 'TURN_NOT_FOUND',
      category: 'validation',
      message: 'Not found',
      turnId: 'turn-456',
    });
    assert.equal(resp.turnId, 'turn-456');
  });

  it('supports optional retryAfterMs field', () => {
    const resp = createGatewayErrorResponse({
      code: 'RATE_LIMITED',
      category: 'rate-limit',
      message: 'Too many requests',
      retryAfterMs: 5000,
    });
    assert.equal(resp.retryAfterMs, 5000);
  });

  it('omits optional fields when not provided', () => {
    const resp = createGatewayErrorResponse({
      code: 'DAEMON_UNREACHABLE',
      category: 'daemon',
      message: 'Daemon down',
    });
    assert.equal(resp.conversationId, undefined);
    assert.equal(resp.turnId, undefined);
    assert.equal(resp.retryAfterMs, undefined);
  });

  it('discriminates each category correctly', () => {
    const cases: Array<{ category: ErrorCategory; code: string }> = [
      { category: 'auth', code: 'INVALID_CREDENTIALS' },
      { category: 'session', code: 'SESSION_EXPIRED' },
      { category: 'validation', code: 'VALIDATION_FAILED' },
      { category: 'daemon', code: 'DAEMON_UNREACHABLE' },
      { category: 'rate-limit', code: 'RATE_LIMITED' },
      { category: 'stale-revision', code: 'STALE_REVISION' },
      { category: 'daemon-unavailable', code: 'DAEMON_UNAVAILABLE' },
      { category: 'workflow-conflict', code: 'WORKFLOW_CONFLICT' },
    ];

    for (const { category, code } of cases) {
      const resp = createGatewayErrorResponse({
        code,
        category,
        message: `Test ${category}`,
      });
      assert.equal(resp.category, category, `Expected category ${category}`);
    }
  });
});
