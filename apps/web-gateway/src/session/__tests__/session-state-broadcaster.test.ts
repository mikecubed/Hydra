import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SessionStateBroadcaster } from '../session-state-broadcaster.ts';

describe('SessionStateBroadcaster', () => {
  let broadcaster: SessionStateBroadcaster;

  beforeEach(() => {
    broadcaster = new SessionStateBroadcaster();
  });

  it('registers and broadcasts to connection', () => {
    const events: Array<{ type: string; previousState: string; newState: string }> = [];
    broadcaster.register('sess-1', (e) => events.push(e));
    broadcaster.broadcast('sess-1', {
      type: 'state-change',
      previousState: 'active',
      newState: 'expired',
    });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.newState, 'expired');
  });

  it('broadcasts to all registered connections', () => {
    let count = 0;
    broadcaster.register('sess-1', () => count++);
    broadcaster.register('sess-1', () => count++);
    broadcaster.broadcast('sess-1', {
      type: 'state-change',
      previousState: 'active',
      newState: 'logged-out',
    });
    assert.equal(count, 2);
  });

  it('does not broadcast to other sessions', () => {
    let called = false;
    broadcaster.register('sess-2', () => {
      called = true;
    });
    broadcaster.broadcast('sess-1', {
      type: 'state-change',
      previousState: 'active',
      newState: 'expired',
    });
    assert.equal(called, false);
  });

  it('removes failed callbacks', () => {
    broadcaster.register('sess-1', () => {
      throw new Error('failed');
    });
    broadcaster.broadcast('sess-1', {
      type: 'state-change',
      previousState: 'active',
      newState: 'expired',
    });
    assert.equal(broadcaster.getListenerCount('sess-1'), 0);
  });

  it('unregisters callback', () => {
    const cb = () => {};
    broadcaster.register('sess-1', cb);
    assert.equal(broadcaster.getListenerCount('sess-1'), 1);
    broadcaster.unregister('sess-1', cb);
    assert.equal(broadcaster.getListenerCount('sess-1'), 0);
  });
});
