import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { OperatorStore } from '../operator-store.ts';

describe('OperatorStore', () => {
  let store: OperatorStore;

  beforeEach(() => {
    store = new OperatorStore(null);
  });

  it('creates operator', async () => {
    const op = await store.createOperator('admin', 'Admin User');
    assert.equal(op.id, 'admin');
    assert.equal(op.displayName, 'Admin User');
    assert.equal(op.isActive, true);
    assert.equal(op.credentials.length, 0);
  });

  it('rejects duplicate operator', async () => {
    await store.createOperator('admin', 'Admin');
    await assert.rejects(() => store.createOperator('admin', 'Admin 2'));
  });

  it('adds credential', async () => {
    await store.createOperator('admin', 'Admin');
    const cred = await store.addCredential('admin', 'secret123');
    assert.equal(cred.operatorId, 'admin');
    assert.equal(cred.type, 'password');
    assert.ok(cred.hashedSecret.length > 0);
    assert.ok(cred.salt.length > 0);
  });

  it('looks up by identity', async () => {
    await store.createOperator('admin', 'Admin');
    const found = store.getOperatorByIdentity('admin');
    assert.equal(found?.id, 'admin');
  });

  it('returns undefined for unknown identity', () => {
    const found = store.getOperatorByIdentity('nonexistent');
    assert.equal(found, undefined);
  });

  it('disables operator', async () => {
    await store.createOperator('admin', 'Admin');
    await store.disableOperator('admin');
    const op = store.getOperator('admin');
    assert.equal(op?.isActive, false);
  });
});
