import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AuditEventType, AuditRecord } from '../audit-schemas.ts';

describe('AuditEventType', () => {
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
    'session.idle-timeout',
    'config.routing.mode.changed',
    'config.models.active.changed',
    'config.usage.budget.changed',
    'workflow.launched',
    'config.mutation.rejected',
    'workflow.launch.rejected',
  ] as const;

  it('has exactly 18 in-scope types', () => {
    assert.equal(AuditEventType.options.length, 18);
  });

  for (const type of allTypes) {
    it(`accepts type: ${type}`, () => {
      assert.equal(AuditEventType.parse(type), type);
    });
  }

  it('rejects unknown type', () => {
    assert.throws(() => AuditEventType.parse('auth.unknown'));
  });
});

describe('AuditRecord', () => {
  const valid = {
    id: 'audit-001',
    timestamp: new Date().toISOString(),
    eventType: 'auth.attempt.success' as const,
    operatorId: 'op-1',
    sessionId: 'sess-1',
    outcome: 'success' as const,
    detail: { credentialType: 'password' },
  };

  it('accepts valid record', () => {
    const result = AuditRecord.parse(valid);
    assert.equal(result.id, 'audit-001');
    assert.equal(result.outcome, 'success');
  });

  it('accepts null operatorId (failed auth)', () => {
    const result = AuditRecord.parse({ ...valid, operatorId: null });
    assert.equal(result.operatorId, null);
  });

  it('accepts null sessionId (pre-session event)', () => {
    const result = AuditRecord.parse({ ...valid, sessionId: null });
    assert.equal(result.sessionId, null);
  });

  it('rejects missing eventType', () => {
    const { eventType: _, ...rest } = valid;
    assert.throws(() => AuditRecord.parse(rest));
  });

  it('rejects invalid outcome', () => {
    assert.throws(() => AuditRecord.parse({ ...valid, outcome: 'maybe' }));
  });
});
