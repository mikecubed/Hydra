import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SessionService } from '../session-service.ts';
import { SessionStore } from '../session-store.ts';
import { FakeClock } from '../../shared/clock.ts';
import { AuditService } from '../../audit/audit-service.ts';
import { AuditStore } from '../../audit/audit-store.ts';

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

  it('creates session with valid operator', async () => {
    const session = await service.create('op-1', '127.0.0.1');
    assert.equal(session.operatorId, 'op-1');
    assert.equal(session.state, 'active');
  });

  it('validates active session', async () => {
    const session = await service.create('op-1', '127.0.0.1');
    const validated = await service.validate(session.id);
    assert.equal(validated.state, 'active');
  });

  it('validates expired session throws', async () => {
    const session = await service.create('op-1', '127.0.0.1');
    clock.advance(3600_001);
    await assert.rejects(() => service.validate(session.id), { message: /expired/i });
  });

  it('validates invalidated session throws', async () => {
    const session = await service.create('op-1', '127.0.0.1');
    await service.invalidate(session.id, 'test');
    await assert.rejects(() => service.validate(session.id), { message: /invalidated/i });
  });

  it('enforces concurrent session limit', async () => {
    const s1 = await service.create('op-1', '127.0.0.1');
    await service.create('op-1', '127.0.0.1');
    // Third session should invalidate oldest
    await service.create('op-1', '127.0.0.1');
    const s1After = store.get(s1.id);
    assert.equal(s1After?.state, 'invalidated');
  });

  it('detects idle session', async () => {
    const session = await service.create('op-1', '127.0.0.1');
    clock.advance(1800_001);
    assert.equal(service.isIdle(session), true);
  });

  it('active session is not idle', async () => {
    const session = await service.create('op-1', '127.0.0.1');
    clock.advance(100);
    assert.equal(service.isIdle(session), false);
  });

  it('extends session', async () => {
    const session = await service.create('op-1', '127.0.0.1');
    clock.advance(3000_000);
    // Move to expiring-soon first
    await service.validate(session.id);
    const extended = await service.extend(session.id);
    assert.equal(extended.state, 'active');
    assert.equal(extended.extendedCount, 1);
  });

  it('extends session in window without prior validate() call', async () => {
    const session = await service.create('op-1', '127.0.0.1');
    // Advance into the extension window (within warningThresholdMs of expiry)
    // Session lifetime is 3600s, warning threshold is 600s, so advance to 3001s
    clock.advance(3001_000);
    // Do NOT call validate() — extend should still work
    const extended = await service.extend(session.id);
    assert.equal(extended.state, 'active');
    assert.equal(extended.extendedCount, 1);
  });

  it('rejects extension for session not yet in window', async () => {
    const session = await service.create('op-1', '127.0.0.1');
    // Only advance 100ms — far from the window
    clock.advance(100);
    await assert.rejects(() => service.extend(session.id), {
      message: /not within the extension window/i,
    });
  });

  it('rejects extension for expired session', async () => {
    const session = await service.create('op-1', '127.0.0.1');
    // Advance past expiry
    clock.advance(3600_001);
    await assert.rejects(() => service.extend(session.id), {
      message: /not within the extension window/i,
    });
  });

  it('rejects extension when max extensions reached', async () => {
    const session = await service.create('op-1', '127.0.0.1');
    // Extend 3 times (max)
    for (let i = 0; i < 3; i++) {
      clock.advance(3001_000);
      await service.extend(session.id);
    }
    // Fourth extension should fail
    clock.advance(3001_000);
    await assert.rejects(() => service.extend(session.id), { message: /maximum/i });
  });

  it('logout transitions to logged-out', async () => {
    const session = await service.create('op-1', '127.0.0.1');
    await service.logout(session.id);
    const s = store.get(session.id);
    assert.equal(s?.state, 'logged-out');
  });

  it('invalidateAllForOperator invalidates all sessions', async () => {
    const s1 = await service.create('op-1', '127.0.0.1');
    const s2 = await service.create('op-1', '127.0.0.1');
    await service.invalidateAllForOperator('op-1', 'daemon restart');
    assert.equal(store.get(s1.id)?.state, 'invalidated');
    assert.equal(store.get(s2.id)?.state, 'invalidated');
  });

  it('logout during daemon outage leaves session unusable', async () => {
    const session = await service.create('op-1', '127.0.0.1');

    // Simulate daemon going down
    await service.markDaemonDown(session.id);
    assert.equal(store.get(session.id)?.state, 'daemon-unreachable');

    // Logout while daemon is unreachable
    await service.logout(session.id);
    assert.equal(store.get(session.id)?.state, 'logged-out');

    // Session must be rejected on subsequent validate
    await assert.rejects(() => service.validate(session.id), {
      message: /session/i,
    });
  });

  it('invalidate during daemon outage leaves session unusable', async () => {
    const session = await service.create('op-1', '127.0.0.1');

    await service.markDaemonDown(session.id);
    assert.equal(store.get(session.id)?.state, 'daemon-unreachable');

    await service.invalidate(session.id, 'admin-revoke');
    assert.equal(store.get(session.id)?.state, 'invalidated');
    assert.equal(store.get(session.id)?.invalidatedReason, 'admin-revoke');

    await assert.rejects(() => service.validate(session.id), {
      message: /invalidated/i,
    });
  });
});

describe('SessionService audit failure propagation', () => {
  it('create() propagates audit write failure', async () => {
    const clock = new FakeClock(Date.now());
    const store = new SessionStore(null);
    const auditStore = new AuditStore(null);
    const auditService = new AuditService(auditStore, clock);

    // Sabotage the audit store
    auditStore.append = async () => {
      throw new Error('Audit disk full');
    };

    const service = new SessionService(store, clock, {}, auditService);
    await assert.rejects(() => service.create('op-1', '127.0.0.1'), {
      message: /Audit disk full/,
    });
  });

  it('extend() propagates audit write failure', async () => {
    const clock = new FakeClock(Date.now());
    const store = new SessionStore(null);
    const auditStore = new AuditStore(null);
    const auditService = new AuditService(auditStore, clock);
    const service = new SessionService(
      store,
      clock,
      { sessionLifetimeMs: 3600_000, warningThresholdMs: 600_000 },
      auditService,
    );

    const session = await service.create('op-1', '127.0.0.1');
    clock.advance(3001_000);

    // Sabotage audit after session creation
    auditStore.append = async () => {
      throw new Error('Audit disk full');
    };

    await assert.rejects(() => service.extend(session.id), {
      message: /Audit disk full/,
    });
  });

  it('logout() propagates audit write failure', async () => {
    const clock = new FakeClock(Date.now());
    const store = new SessionStore(null);
    const auditStore = new AuditStore(null);
    const auditService = new AuditService(auditStore, clock);
    const service = new SessionService(store, clock, {}, auditService);

    const session = await service.create('op-1', '127.0.0.1');

    // Sabotage audit after session creation
    auditStore.append = async () => {
      throw new Error('Audit disk full');
    };

    await assert.rejects(() => service.logout(session.id), {
      message: /Audit disk full/,
    });
  });
});
