import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AuditService } from '../audit-service.ts';
import { AuditStore } from '../audit-store.ts';
import { FakeClock } from '../../shared/clock.ts';

describe('AuditService', () => {
  let store: AuditStore;
  let service: AuditService;
  let clock: FakeClock;

  beforeEach(() => {
    store = new AuditStore(null);
    clock = new FakeClock(Date.now());
    service = new AuditService(store, clock);
  });

  it('records valid event', async () => {
    const record = await service.record(
      'auth.attempt.success',
      'op-1',
      'sess-1',
      { credentialType: 'password' },
      'success',
    );
    assert.ok(record.id);
    assert.equal(record.eventType, 'auth.attempt.success');
    assert.equal(record.outcome, 'success');
  });

  const allTypes = [
    'auth.attempt.success',
    'auth.attempt.failure',
    'auth.rate-limited',
    'session.created',
    'session.extended',
    'session.expired',
    'session.invalidated',
    'session.logged-out',
    'session.daemon-unreachable',
    'session.daemon-restored',
    'session.idle-reauth',
  ];

  for (const type of allTypes) {
    it(`accepts event type: ${type}`, async () => {
      const record = await service.record(type, null, null, {}, 'success');
      assert.equal(record.eventType, type);
    });
  }

  it('rejects invalid type', async () => {
    await assert.rejects(() => service.record('auth.unknown', null, null, {}, 'success'));
  });

  it('uses injected clock for timestamp', async () => {
    clock.set(1000000000000);
    const record = await service.record('session.created', 'op-1', 'sess-1', {}, 'success');
    assert.equal(new Date(record.timestamp).getTime(), 1000000000000);
  });

  it('getRecords returns all recorded events', async () => {
    await service.record('auth.attempt.success', 'op-1', null, {}, 'success');
    await service.record('session.created', 'op-1', 'sess-1', {}, 'success');
    assert.equal(service.getRecords().length, 2);
  });
});
