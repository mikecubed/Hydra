import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GatewayError, createError, ERROR_STATUS_MAP, type ErrorCode } from '../errors.ts';

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
    'IDLE_TIMEOUT',
    'DAEMON_UNREACHABLE',
    'CLOCK_UNRELIABLE',
    'CSRF_INVALID',
    'ORIGIN_REJECTED',
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
});

describe('ERROR_STATUS_MAP', () => {
  it('maps all codes to HTTP status codes', () => {
    const codes = Object.keys(ERROR_STATUS_MAP);
    assert.equal(codes.length, 11);
    for (const code of codes) {
      const status = ERROR_STATUS_MAP[code as ErrorCode];
      assert.ok(status >= 400 && status < 600, `${code} should map to a 4xx/5xx status`);
    }
  });
});
