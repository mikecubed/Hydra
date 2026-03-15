import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMutatingRateLimiter } from '../mutating-rate-limiter.ts';
import { FakeClock } from '../../shared/clock.ts';
import { createMockReqRes } from '../../shared/__tests__/test-helpers.ts';

describe('Mutating rate limiter', () => {
  let clock: FakeClock;

  beforeEach(() => {
    clock = new FakeClock(Date.now());
  });

  it('GET passes through', () => {
    const limiter = createMutatingRateLimiter(clock, {
      maxAttempts: 3,
      windowMs: 60000,
      lockoutMs: 60000,
    });
    const { req, res } = createMockReqRes('GET');
    let called = false;
    limiter(req, res, () => {
      called = true;
    });
    assert.equal(called, true);
  });

  it('POST under threshold passes', () => {
    const limiter = createMutatingRateLimiter(clock, {
      maxAttempts: 3,
      windowMs: 60000,
      lockoutMs: 60000,
    });
    const { req, res } = createMockReqRes('POST');
    let called = false;
    limiter(req, res, () => {
      called = true;
    });
    assert.equal(called, true);
  });

  it('at threshold returns 429', () => {
    const limiter = createMutatingRateLimiter(clock, {
      maxAttempts: 2,
      windowMs: 60000,
      lockoutMs: 60000,
    });
    // Use up the attempts
    for (let i = 0; i < 2; i++) {
      const { req, res } = createMockReqRes('POST');
      limiter(req, res, () => {});
    }
    const { req, res } = createMockReqRes('POST');
    limiter(req, res, () => {});
    assert.equal(res.statusCode, 429);
  });

  it('window slides', () => {
    const limiter = createMutatingRateLimiter(clock, {
      maxAttempts: 2,
      windowMs: 60000,
      lockoutMs: 60000,
    });
    for (let i = 0; i < 2; i++) {
      const { req, res } = createMockReqRes('POST');
      limiter(req, res, () => {});
    }
    clock.advance(60001);
    // After lockout
    clock.advance(60001);
    const { req, res } = createMockReqRes('POST');
    let called = false;
    limiter(req, res, () => {
      called = true;
    });
    assert.equal(called, true);
  });
});
