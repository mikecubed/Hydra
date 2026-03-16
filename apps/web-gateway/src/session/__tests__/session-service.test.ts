import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SessionService } from '../session-service.ts';
import { SessionStore } from '../session-store.ts';
import { FakeClock } from '../../shared/clock.ts';
import { AuditService } from '../../audit/audit-service.ts';
import { AuditStore } from '../../audit/audit-store.ts';
import type { GatewayError } from '../../shared/errors.ts';

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

  it('rejects extension with DAEMON_UNREACHABLE when daemon is down', async () => {
    const session = await service.create('op-1', '127.0.0.1');
    await service.markDaemonDown(session.id);
    assert.equal(store.get(session.id)?.state, 'daemon-unreachable');

    await assert.rejects(
      () => service.extend(session.id),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        const ge = err as GatewayError;
        assert.equal(ge.code, 'DAEMON_UNREACHABLE');
        assert.equal(ge.statusCode, 503);
        return true;
      },
    );
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

  it('markDaemonDown transitions expiring-soon session to daemon-unreachable', async () => {
    const session = await service.create('op-1', '127.0.0.1');

    // Advance into warning window and validate to reach expiring-soon
    clock.advance(3001_000);
    await service.validate(session.id);
    assert.equal(store.get(session.id)?.state, 'expiring-soon');

    // markDaemonDown must succeed on expiring-soon
    await service.markDaemonDown(session.id);
    assert.equal(store.get(session.id)?.state, 'daemon-unreachable');

    // markDaemonUp restores session
    await service.markDaemonUp(session.id);
    assert.equal(store.get(session.id)?.state, 'active');
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

  it('create() rolls back — no live session left after audit failure', async () => {
    const clock = new FakeClock(Date.now());
    const store = new SessionStore(null);
    const auditStore = new AuditStore(null);
    const auditService = new AuditService(auditStore, clock);

    auditStore.append = async () => {
      throw new Error('Audit disk full');
    };

    const service = new SessionService(store, clock, {}, auditService);
    await assert.rejects(() => service.create('op-1', '127.0.0.1'));

    // No session should exist in the store
    const sessions = store.listByOperator('op-1');
    assert.equal(sessions.length, 0, 'failed create must not leave a live session');
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

  it('extend() rolls back — extendedCount and expiresAt unchanged after audit failure', async () => {
    const clock = new FakeClock(Date.now());
    const store = new SessionStore(null);
    const auditStore = new AuditStore(null);
    const auditService = new AuditService(auditStore, clock);
    const service = new SessionService(
      store,
      clock,
      { sessionLifetimeMs: 3600_000, warningThresholdMs: 600_000, extensionDurationMs: 3600_000 },
      auditService,
    );

    const session = await service.create('op-1', '127.0.0.1');
    const originalExpiresAt = session.expiresAt;
    const originalExtendedCount = session.extendedCount;

    clock.advance(3001_000);

    auditStore.append = async () => {
      throw new Error('Audit disk full');
    };

    await assert.rejects(() => service.extend(session.id));

    const afterFail = store.get(session.id);
    assert.ok(afterFail);
    assert.equal(afterFail.extendedCount, originalExtendedCount, 'extendedCount must not change');
    assert.equal(afterFail.expiresAt, originalExpiresAt, 'expiresAt must not change');
    assert.equal(afterFail.state, 'active', 'state must revert to original');
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

  it('logout() rolls back — session remains active after audit failure', async () => {
    const clock = new FakeClock(Date.now());
    const store = new SessionStore(null);
    const auditStore = new AuditStore(null);
    const auditService = new AuditService(auditStore, clock);
    const service = new SessionService(store, clock, {}, auditService);

    const session = await service.create('op-1', '127.0.0.1');

    auditStore.append = async () => {
      throw new Error('Audit disk full');
    };

    await assert.rejects(() => service.logout(session.id));

    const afterFail = store.get(session.id);
    assert.ok(afterFail);
    assert.equal(afterFail.state, 'active', 'state must revert on audit failure');
  });
});

describe('SessionService warn-expiry with audit service', () => {
  it('validate() near-expiry session does not throw when audit service is attached', async () => {
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
    // Advance into the warning window but before absolute expiry
    clock.advance(3001_000);

    // Must not throw — warn-expiry has no audit mapping and should be silently skipped
    const validated = await service.validate(session.id);
    assert.equal(validated.state, 'expiring-soon');
  });

  it('validate() near-expiry does not emit an audit record for warn-expiry', async () => {
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
    const recordsBefore = auditService.getRecords().length;

    clock.advance(3001_000);
    await service.validate(session.id);

    // Only the session.created audit record should exist — no warn-expiry event
    const recordsAfter = auditService.getRecords();
    assert.equal(recordsAfter.length, recordsBefore, 'warn-expiry must not emit an audit record');
  });
});

describe('SessionService audit payload accuracy', () => {
  it('session.extended audit records the correct extendedCount matching stored state', async () => {
    const clock = new FakeClock(Date.now());
    const store = new SessionStore(null);
    const auditStore = new AuditStore(null);
    const auditService = new AuditService(auditStore, clock);
    const service = new SessionService(
      store,
      clock,
      { sessionLifetimeMs: 3600_000, warningThresholdMs: 600_000, extensionDurationMs: 3600_000 },
      auditService,
    );

    const session = await service.create('op-1', '127.0.0.1');

    // First extension
    clock.advance(3001_000);
    await service.extend(session.id);

    // Second extension
    clock.advance(3001_000);
    await service.extend(session.id);

    const records = auditService.getRecords();
    const extendRecords = records.filter((r) => r.eventType === 'session.extended');
    assert.equal(extendRecords.length, 2);

    // Each audit record's extendedCount must match the actual stored state
    // at the time it was emitted (1 for first extend, 2 for second).
    const firstDetail = extendRecords[0].detail as { extendedCount: number };
    const secondDetail = extendRecords[1].detail as { extendedCount: number };
    assert.equal(firstDetail.extendedCount, 1, 'first extend audit must report extendedCount=1');
    assert.equal(secondDetail.extendedCount, 2, 'second extend audit must report extendedCount=2');

    // Final stored state must agree
    const final = store.get(session.id);
    assert.ok(final);
    assert.equal(final.extendedCount, 2);
  });
});
