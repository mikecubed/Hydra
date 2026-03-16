import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SessionStore } from '../session-store.ts';

describe('SessionStore', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(null);
  });

  it('create returns valid session', () => {
    const session = store.create('op-1', new Date(Date.now() + 3600000).toISOString(), '127.0.0.1');
    assert.ok(session.id.length > 0);
    assert.equal(session.operatorId, 'op-1');
    assert.equal(session.state, 'active');
    assert.equal(session.extendedCount, 0);
    assert.ok(session.csrfToken.length > 0);
  });

  it('get by ID', () => {
    const session = store.create('op-1', new Date(Date.now() + 3600000).toISOString(), '127.0.0.1');
    const found = store.get(session.id);
    assert.equal(found?.id, session.id);
  });

  it('get unknown ID returns undefined', () => {
    const found = store.get('nonexistent');
    assert.equal(found, undefined);
  });

  it('delete removes session', () => {
    const session = store.create('op-1', new Date(Date.now() + 3600000).toISOString(), '127.0.0.1');
    assert.equal(store.delete(session.id), true);
    assert.equal(store.get(session.id), undefined);
  });

  it('list by operator', () => {
    store.create('op-1', new Date(Date.now() + 3600000).toISOString(), '127.0.0.1');
    store.create('op-1', new Date(Date.now() + 3600000).toISOString(), '127.0.0.1');
    store.create('op-2', new Date(Date.now() + 3600000).toISOString(), '127.0.0.1');
    assert.equal(store.listByOperator('op-1').length, 2);
    assert.equal(store.listByOperator('op-2').length, 1);
  });

  it('creates unique session IDs', () => {
    const s1 = store.create('op-1', new Date(Date.now() + 3600000).toISOString(), '127.0.0.1');
    const s2 = store.create('op-1', new Date(Date.now() + 3600000).toISOString(), '127.0.0.1');
    assert.notEqual(s1.id, s2.id);
  });

  it('creates unique CSRF tokens', () => {
    const s1 = store.create('op-1', new Date(Date.now() + 3600000).toISOString(), '127.0.0.1');
    const s2 = store.create('op-1', new Date(Date.now() + 3600000).toISOString(), '127.0.0.1');
    assert.notEqual(s1.csrfToken, s2.csrfToken);
  });

  it('update modifies session', () => {
    const session = store.create('op-1', new Date(Date.now() + 3600000).toISOString(), '127.0.0.1');
    store.update(session.id, { state: 'expired' });
    const found = store.get(session.id);
    assert.equal(found?.state, 'expired');
  });
});
