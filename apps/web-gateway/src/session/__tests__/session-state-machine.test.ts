import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  transition,
  getValidTriggers,
  isTerminal,
  type SessionTrigger,
} from '../session-state-machine.ts';
import type { SessionState } from '@hydra/web-contracts';

describe('session-state-machine', () => {
  describe('valid transitions', () => {
    const cases: Array<{ from: SessionState; trigger: SessionTrigger; to: SessionState }> = [
      { from: 'active', trigger: 'warn-expiry', to: 'expiring-soon' },
      { from: 'active', trigger: 'expire', to: 'expired' },
      { from: 'active', trigger: 'invalidate', to: 'invalidated' },
      { from: 'active', trigger: 'logout', to: 'logged-out' },
      { from: 'active', trigger: 'daemon-down', to: 'daemon-unreachable' },
      { from: 'expiring-soon', trigger: 'extend', to: 'active' },
      { from: 'expiring-soon', trigger: 'expire', to: 'expired' },
      { from: 'expiring-soon', trigger: 'invalidate', to: 'invalidated' },
      { from: 'expiring-soon', trigger: 'logout', to: 'logged-out' },
      { from: 'daemon-unreachable', trigger: 'daemon-up', to: 'active' },
      { from: 'daemon-unreachable', trigger: 'expire', to: 'expired' },
    ];

    for (const { from, trigger, to } of cases) {
      it(`${from} + ${trigger} → ${to}`, () => {
        const result = transition(from, trigger);
        assert.ok(result.ok);
        if (result.ok) assert.equal(result.newState, to);
      });
    }
  });

  describe('terminal states reject all transitions', () => {
    const terminals: SessionState[] = ['expired', 'invalidated', 'logged-out'];
    const triggers: SessionTrigger[] = [
      'warn-expiry',
      'expire',
      'invalidate',
      'logout',
      'daemon-down',
      'daemon-up',
      'extend',
    ];

    for (const state of terminals) {
      for (const trigger of triggers) {
        it(`${state} + ${trigger} → error`, () => {
          const result = transition(state, trigger);
          assert.equal(result.ok, false);
        });
      }
    }
  });

  describe('invalid transitions from non-terminal states', () => {
    it('active + extend → error', () => {
      const result = transition('active', 'extend');
      assert.equal(result.ok, false);
    });

    it('active + daemon-up → error', () => {
      const result = transition('active', 'daemon-up');
      assert.equal(result.ok, false);
    });
  });

  describe('isTerminal', () => {
    it('expired is terminal', () => {
      assert.equal(isTerminal('expired'), true);
    });
    it('invalidated is terminal', () => {
      assert.equal(isTerminal('invalidated'), true);
    });
    it('logged-out is terminal', () => {
      assert.equal(isTerminal('logged-out'), true);
    });
    it('active is not terminal', () => {
      assert.equal(isTerminal('active'), false);
    });
    it('expiring-soon is not terminal', () => {
      assert.equal(isTerminal('expiring-soon'), false);
    });
    it('daemon-unreachable is not terminal', () => {
      assert.equal(isTerminal('daemon-unreachable'), false);
    });
  });

  describe('getValidTriggers', () => {
    it('active has 5 triggers', () => {
      assert.equal(getValidTriggers('active').length, 5);
    });

    it('expiring-soon has 4 triggers', () => {
      assert.equal(getValidTriggers('expiring-soon').length, 4);
    });

    it('daemon-unreachable has 2 triggers', () => {
      assert.equal(getValidTriggers('daemon-unreachable').length, 2);
    });

    it('terminal states have 0 triggers', () => {
      assert.equal(getValidTriggers('expired').length, 0);
      assert.equal(getValidTriggers('invalidated').length, 0);
      assert.equal(getValidTriggers('logged-out').length, 0);
    });
  });

  describe('all 6 states reachable', () => {
    it('all states can be reached via valid transitions', () => {
      const reachable = new Set<SessionState>(['active']); // initial state

      // active → expiring-soon
      const r1 = transition('active', 'warn-expiry');
      if (r1.ok) reachable.add(r1.newState);

      // active → expired
      const r2 = transition('active', 'expire');
      if (r2.ok) reachable.add(r2.newState);

      // active → invalidated
      const r3 = transition('active', 'invalidate');
      if (r3.ok) reachable.add(r3.newState);

      // active → logged-out
      const r4 = transition('active', 'logout');
      if (r4.ok) reachable.add(r4.newState);

      // active → daemon-unreachable
      const r5 = transition('active', 'daemon-down');
      if (r5.ok) reachable.add(r5.newState);

      assert.equal(reachable.size, 6);
    });
  });
});
