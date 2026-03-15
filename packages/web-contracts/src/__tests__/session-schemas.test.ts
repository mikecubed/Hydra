import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SessionState,
  TERMINAL_STATES,
  SessionInfo,
  SessionEvent,
  ExtendResponse,
} from '../session-schemas.ts';

describe('SessionState', () => {
  const validStates = [
    'active',
    'expiring-soon',
    'expired',
    'invalidated',
    'logged-out',
    'daemon-unreachable',
  ] as const;

  for (const state of validStates) {
    it(`accepts valid state: ${state}`, () => {
      assert.equal(SessionState.parse(state), state);
    });
  }

  it('rejects invalid state', () => {
    assert.throws(() => SessionState.parse('bogus'));
  });
});

describe('TERMINAL_STATES', () => {
  it('contains expired, invalidated, logged-out', () => {
    assert.deepStrictEqual([...TERMINAL_STATES].sort(), ['expired', 'invalidated', 'logged-out']);
  });
});

describe('SessionInfo', () => {
  const valid = {
    operatorId: 'op-1',
    state: 'active' as const,
    expiresAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };

  it('accepts valid SessionInfo', () => {
    const result = SessionInfo.parse(valid);
    assert.equal(result.operatorId, 'op-1');
    assert.equal(result.state, 'active');
  });

  it('rejects missing operatorId', () => {
    assert.throws(() => SessionInfo.parse({ ...valid, operatorId: '' }));
  });

  it('rejects invalid state', () => {
    assert.throws(() => SessionInfo.parse({ ...valid, state: 'nope' }));
  });

  it('roundtrips through parse', () => {
    const result = SessionInfo.parse(valid);
    const reparsed = SessionInfo.parse(result);
    assert.deepStrictEqual(result, reparsed);
  });
});

describe('SessionEvent', () => {
  it('accepts valid event', () => {
    const result = SessionEvent.parse({ type: 'state-change', newState: 'expired' });
    assert.equal(result.type, 'state-change');
    assert.equal(result.newState, 'expired');
    assert.equal(result.reason, undefined);
  });

  it('accepts optional reason', () => {
    const result = SessionEvent.parse({
      type: 'forced-logout',
      newState: 'logged-out',
      reason: 'admin action',
    });
    assert.equal(result.reason, 'admin action');
  });

  it('rejects invalid type', () => {
    assert.throws(() => SessionEvent.parse({ type: 'bad', newState: 'active' }));
  });
});

describe('ExtendResponse', () => {
  it('accepts valid extend response', () => {
    const result = ExtendResponse.parse({ newExpiresAt: new Date().toISOString() });
    assert.ok(result.newExpiresAt);
  });

  it('rejects missing newExpiresAt', () => {
    assert.throws(() => ExtendResponse.parse({}));
  });
});
