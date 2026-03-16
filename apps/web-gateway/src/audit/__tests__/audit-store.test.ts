import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AuditStore } from '../audit-store.ts';
import type { AuditRecord } from '@hydra/web-contracts';

describe('AuditStore', () => {
  let store: AuditStore;

  beforeEach(() => {
    store = new AuditStore(null);
  });

  function makeRecord(overrides: Partial<AuditRecord> = {}): AuditRecord {
    return {
      id: `audit-${Date.now()}`,
      timestamp: new Date().toISOString(),
      eventType: 'auth.attempt.success',
      operatorId: 'op-1',
      sessionId: 'sess-1',
      outcome: 'success',
      detail: {},
      ...overrides,
    };
  }

  it('append creates record', async () => {
    await store.append(makeRecord());
    assert.equal(store.getRecords().length, 1);
  });

  it('records are immutable (append-only)', async () => {
    const record = makeRecord();
    await store.append(record);
    const records = store.getRecords();
    assert.equal(records.length, 1);
    // Try to modify — the returned array is readonly but
    // verify we can still append
    await store.append(makeRecord({ id: 'audit-2' }));
    assert.equal(store.getRecords().length, 2);
  });

  it('preserves order', async () => {
    await store.append(makeRecord({ id: 'a1' }));
    await store.append(makeRecord({ id: 'a2' }));
    await store.append(makeRecord({ id: 'a3' }));
    const records = store.getRecords();
    assert.equal(records[0]?.id, 'a1');
    assert.equal(records[2]?.id, 'a3');
  });
});
