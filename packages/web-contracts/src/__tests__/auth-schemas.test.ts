import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LoginRequest, LoginResponse, LogoutResponse, AuthError } from '../auth-schemas.ts';

describe('LoginRequest', () => {
  it('accepts valid request', () => {
    const result = LoginRequest.parse({ identity: 'admin', secret: 'pass123' });
    assert.equal(result.identity, 'admin');
    assert.equal(result.secret, 'pass123');
  });

  it('rejects empty identity', () => {
    assert.throws(() => LoginRequest.parse({ identity: '', secret: 'pass' }));
  });

  it('rejects empty secret', () => {
    assert.throws(() => LoginRequest.parse({ identity: 'admin', secret: '' }));
  });

  it('rejects missing fields', () => {
    assert.throws(() => LoginRequest.parse({}));
  });
});

describe('LoginResponse', () => {
  it('accepts valid response', () => {
    const result = LoginResponse.parse({
      operatorId: 'op-1',
      expiresAt: new Date().toISOString(),
      state: 'active',
    });
    assert.equal(result.operatorId, 'op-1');
    assert.equal(result.state, 'active');
  });

  it('does not accept sessionId field', () => {
    const input = {
      operatorId: 'op-1',
      expiresAt: new Date().toISOString(),
      state: 'active',
      sessionId: 'leaked-id',
    };
    const result = LoginResponse.safeParse(input);
    assert.equal(result.success, false, 'strict schema must reject unknown fields like sessionId');
  });

  it('rejects missing operatorId', () => {
    assert.throws(() =>
      LoginResponse.parse({ expiresAt: new Date().toISOString(), state: 'active' }),
    );
  });
});

describe('LogoutResponse', () => {
  it('accepts success: true', () => {
    const result = LogoutResponse.parse({ success: true });
    assert.equal(result.success, true);
  });

  it('accepts success: false', () => {
    const result = LogoutResponse.parse({ success: false });
    assert.equal(result.success, false);
  });
});

describe('AuthError', () => {
  it('accepts valid error', () => {
    const result = AuthError.parse({ code: 'INVALID_CREDENTIALS', message: 'Bad login' });
    assert.equal(result.code, 'INVALID_CREDENTIALS');
  });

  it('rejects empty code', () => {
    assert.throws(() => AuthError.parse({ code: '', message: 'x' }));
  });

  it('rejects empty message', () => {
    assert.throws(() => AuthError.parse({ code: 'X', message: '' }));
  });
});
