import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../rate-limiter.ts';
import { FakeClock } from '../../shared/clock.ts';

describe('RateLimiter', () => {
  let clock: FakeClock;
  let limiter: RateLimiter;

  beforeEach(() => {
    clock = new FakeClock(1000000);
    limiter = new RateLimiter(clock, {
      maxAttempts: 3,
      windowMs: 60_000,
      lockoutMs: 300_000,
    });
  });

  it('allows under threshold', () => {
    assert.equal(limiter.check('ip1'), true);
    limiter.recordFailure('ip1');
    assert.equal(limiter.check('ip1'), true);
  });

  it('blocks at threshold', () => {
    limiter.recordFailure('ip1');
    limiter.recordFailure('ip1');
    limiter.recordFailure('ip1'); // 3rd = locked
    assert.equal(limiter.check('ip1'), false);
  });

  it('lockout expires', () => {
    limiter.recordFailure('ip1');
    limiter.recordFailure('ip1');
    limiter.recordFailure('ip1');
    assert.equal(limiter.check('ip1'), false);

    clock.advance(300_001);
    assert.equal(limiter.check('ip1'), true);
  });

  it('window slides', () => {
    limiter.recordFailure('ip1');
    limiter.recordFailure('ip1');
    clock.advance(60_001); // window slides past first two
    assert.equal(limiter.check('ip1'), true);
    limiter.recordFailure('ip1');
    assert.equal(limiter.check('ip1'), true);
  });

  it('separate keys are independent', () => {
    limiter.recordFailure('ip1');
    limiter.recordFailure('ip1');
    limiter.recordFailure('ip1');
    assert.equal(limiter.check('ip1'), false);
    assert.equal(limiter.check('ip2'), true);
  });

  it('reset clears state', () => {
    limiter.recordFailure('ip1');
    limiter.recordFailure('ip1');
    limiter.recordFailure('ip1');
    assert.equal(limiter.check('ip1'), false);
    limiter.reset('ip1');
    assert.equal(limiter.check('ip1'), true);
  });

  it('recordAttempt behaves identically to recordFailure', () => {
    limiter.recordAttempt('ip3');
    limiter.recordAttempt('ip3');
    assert.equal(limiter.check('ip3'), true);
    limiter.recordAttempt('ip3'); // 3rd = locked
    assert.equal(limiter.check('ip3'), false);
  });
});
