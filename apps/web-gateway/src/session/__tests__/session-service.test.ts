import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SessionService } from '../session-service.ts';
import { SessionStore } from '../session-store.ts';
import { FakeClock } from '../../shared/clock.ts';

describe('SessionService', () => {
  let store: SessionStore;
  let clock: FakeClock;
  let service: SessionService;

  beforeEach(() => {
    store = new SessionStore(null);
    clock = new FakeClock(Date.now());
    service = new SessionService(store, clock, {
      sessionLifetimeMs: 3600_000,
      warningThresholdMs: 600_000,
      maxExtensions: 3,
      extensionDurationMs: 3600_000,
      maxConcurrentSessions: 2,
      idleTimeoutMs: 1800_000,
    });
  });

  it('creates session with valid operator', () => {
    const session = service.create('op-1', '127.0.0.1');
    assert.equal(session.operatorId, 'op-1');
    assert.equal(session.state, 'active');
  });

  it('validates active session', () => {
    const session = service.create('op-1', '127.0.0.1');
    const validated = service.validate(session.id);
    assert.equal(validated.state, 'active');
  });

  it('validates expired session throws', () => {
    const session = service.create('op-1', '127.0.0.1');
    clock.advance(3600_001);
    assert.throws(() => service.validate(session.id), { message: /expired/i });
  });

  it('validates invalidated session throws', () => {
    const session = service.create('op-1', '127.0.0.1');
    service.invalidate(session.id, 'test');
    assert.throws(() => service.validate(session.id), { message: /invalidated/i });
  });

  it('enforces concurrent session limit', () => {
    const s1 = service.create('op-1', '127.0.0.1');
    service.create('op-1', '127.0.0.1');
    // Third session should invalidate oldest
    service.create('op-1', '127.0.0.1');
    const s1After = store.get(s1.id);
    assert.equal(s1After?.state, 'invalidated');
  });

  it('detects idle session', () => {
    const session = service.create('op-1', '127.0.0.1');
    clock.advance(1800_001);
    assert.equal(service.isIdle(session), true);
  });

  it('active session is not idle', () => {
    const session = service.create('op-1', '127.0.0.1');
    clock.advance(100);
    assert.equal(service.isIdle(session), false);
  });

  it('extends session', () => {
    const session = service.create('op-1', '127.0.0.1');
    clock.advance(3000_000);
    // Move to expiring-soon first
    service.validate(session.id);
    const extended = service.extend(session.id);
    assert.equal(extended.state, 'active');
    assert.equal(extended.extendedCount, 1);
  });

  it('extends session in window without prior validate() call', () => {
    const session = service.create('op-1', '127.0.0.1');
    // Advance into the extension window (within warningThresholdMs of expiry)
    // Session lifetime is 3600s, warning threshold is 600s, so advance to 3001s
    clock.advance(3001_000);
    // Do NOT call validate() — extend should still work
    const extended = service.extend(session.id);
    assert.equal(extended.state, 'active');
    assert.equal(extended.extendedCount, 1);
  });

  it('rejects extension for session not yet in window', () => {
    const session = service.create('op-1', '127.0.0.1');
    // Only advance 100ms — far from the window
    clock.advance(100);
    assert.throws(() => service.extend(session.id), {
      message: /not within the extension window/i,
    });
  });

  it('rejects extension for expired session', () => {
    const session = service.create('op-1', '127.0.0.1');
    // Advance past expiry
    clock.advance(3600_001);
    assert.throws(() => service.extend(session.id), {
      message: /not within the extension window/i,
    });
  });

  it('rejects extension when max extensions reached', () => {
    const session = service.create('op-1', '127.0.0.1');
    // Extend 3 times (max)
    for (let i = 0; i < 3; i++) {
      clock.advance(3001_000);
      service.extend(session.id);
    }
    // Fourth extension should fail
    clock.advance(3001_000);
    assert.throws(() => service.extend(session.id), { message: /maximum/i });
  });

  it('logout transitions to logged-out', () => {
    const session = service.create('op-1', '127.0.0.1');
    service.logout(session.id);
    const s = store.get(session.id);
    assert.equal(s?.state, 'logged-out');
  });

  it('invalidateAllForOperator invalidates all sessions', () => {
    const s1 = service.create('op-1', '127.0.0.1');
    const s2 = service.create('op-1', '127.0.0.1');
    service.invalidateAllForOperator('op-1', 'daemon restart');
    assert.equal(store.get(s1.id)?.state, 'invalidated');
    assert.equal(store.get(s2.id)?.state, 'invalidated');
  });
});
