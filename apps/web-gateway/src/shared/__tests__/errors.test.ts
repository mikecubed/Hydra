import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  GatewayError,
  createError,
  ERROR_STATUS_MAP,
  ERROR_CATEGORY_MAP,
  type ErrorCode,
} from '../errors.ts';
import { ERROR_CATEGORIES } from '../gateway-error-response.ts';

describe('GatewayError', () => {
  it('constructs with code, message, and statusCode', () => {
    const err = new GatewayError('INVALID_CREDENTIALS', 'bad login', 401);
    assert.equal(err.code, 'INVALID_CREDENTIALS');
    assert.equal(err.message, 'bad login');
    assert.equal(err.statusCode, 401);
    assert.equal(err.name, 'GatewayError');
  });

  it('is an instance of Error', () => {
    const err = new GatewayError('SESSION_EXPIRED', 'expired', 401);
    assert.ok(err instanceof Error);
  });
});

describe('createError', () => {
  const allCodes: ErrorCode[] = [
    'INVALID_CREDENTIALS',
    'RATE_LIMITED',
    'ACCOUNT_DISABLED',
    'SESSION_EXPIRED',
    'SESSION_INVALIDATED',
    'SESSION_NOT_FOUND',
    'SESSION_NOT_IDLE',
    'IDLE_TIMEOUT',
    'BAD_REQUEST',
    'INTERNAL_ERROR',
    'DAEMON_UNREACHABLE',
    'DAEMON_TIMEOUT',
    'CLOCK_UNRELIABLE',
    'CSRF_INVALID',
    'ORIGIN_REJECTED',
    'CONVERSATION_NOT_FOUND',
    'TURN_NOT_FOUND',
    'VALIDATION_FAILED',
    'WS_INVALID_MESSAGE',
    'WS_BUFFER_OVERFLOW',
  ];

  for (const code of allCodes) {
    it(`creates error for code: ${code}`, () => {
      const err = createError(code);
      assert.equal(err.code, code);
      assert.ok(err.message.length > 0);
      assert.equal(err.statusCode, ERROR_STATUS_MAP[code]);
    });
  }

  it('uses custom message when provided', () => {
    const err = createError('CSRF_INVALID', 'custom msg');
    assert.equal(err.message, 'custom msg');
  });

  it('adds retryAfterMs for gateway-generated RATE_LIMITED errors', () => {
    const err = createError('RATE_LIMITED');
    assert.equal(err.retryAfterMs, 5000);
  });
});

describe('ERROR_STATUS_MAP', () => {
  it('maps all codes to HTTP status codes', () => {
    const codes = Object.keys(ERROR_STATUS_MAP);
    assert.equal(codes.length, 20);
    for (const code of codes) {
      const status = ERROR_STATUS_MAP[code as ErrorCode];
      assert.ok(status >= 400 && status < 600, `${code} should map to a 4xx/5xx status`);
    }
  });
});

describe('ERROR_CATEGORY_MAP', () => {
  it('covers every ErrorCode', () => {
    const statusCodes = Object.keys(ERROR_STATUS_MAP) as ErrorCode[];
    const categoryCodes = Object.keys(ERROR_CATEGORY_MAP) as ErrorCode[];
    assert.deepEqual(categoryCodes.sort(), statusCodes.sort());
  });

  it('maps every code to a valid ErrorCategory', () => {
    for (const [code, category] of Object.entries(ERROR_CATEGORY_MAP)) {
      assert.ok(
        ERROR_CATEGORIES.includes(category),
        `${code} maps to invalid category: ${category}`,
      );
    }
  });
});
