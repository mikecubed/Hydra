/**
 * Tests for hydra-doctor — failure diagnosis and triage layer.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  initDoctor,
  isDoctorEnabled,
  diagnose,
  getDoctorStats,
  getDoctorLog,
  resetDoctor,
} from '../lib/hydra-doctor.ts';
import { _setTestConfig, invalidateConfigCache } from '../lib/hydra-config.ts';

// -- Helpers ------------------------------------------------------------------

function makeFailure(overrides: Record<string, unknown> = {}) {
  return {
    pipeline: 'evolve',
    phase: 'agent',
    agent: 'codex',
    error: 'Agent process exited with code 1',
    stderr: 'Error: something went wrong',
    stdout: '',
    timedOut: false,
    taskTitle: 'test task',
    branchName: 'evolve/test',
    context: '',
    ...overrides,
  };
}

// -- Tests --------------------------------------------------------------------

describe('hydra-doctor', () => {
  beforeEach(() => {
    resetDoctor({ clearPersistent: true });
  });

  afterEach(() => {
    resetDoctor({ clearPersistent: true });
  });

  describe('isDoctorEnabled()', () => {
    it('returns true by default', () => {
      assert.ok(isDoctorEnabled());
    });
  });

  describe('getDoctorStats()', () => {
    it('returns zero counts initially', () => {
      const stats = getDoctorStats();
      assert.equal(stats.total, 0);
      assert.equal(stats.fixes, 0);
      assert.equal(stats.tickets, 0);
      assert.equal(stats.investigations, 0);
      assert.equal(stats.ignored, 0);
    });
  });

  describe('diagnose()', () => {
    it('ignores rate limit errors', async () => {
      const result = await diagnose(
        makeFailure({
          error: '429 Too Many Requests',
          stderr: 'rate limit exceeded',
        }),
      );

      assert.equal(result.action, 'ignore');
      assert.equal(result.rootCause, 'rate_limit');
      assert.equal(result.severity, 'low');

      const stats = getDoctorStats();
      assert.equal(stats.total, 1);
      assert.equal(stats.ignored, 1);
    });

    it('ignores RESOURCE_EXHAUSTED errors', async () => {
      const result = await diagnose(
        makeFailure({
          error: 'RESOURCE_EXHAUSTED: quota exceeded',
        }),
      );

      assert.equal(result.action, 'ignore');
      assert.equal(result.rootCause, 'rate_limit');
    });

    it('produces a valid diagnosis for non-rate-limit failures', async () => {
      const result = await diagnose(
        makeFailure({
          error: 'Segmentation fault in agent subprocess',
        }),
      );

      // The action depends on whether the investigator is available,
      // but it must be one of the valid actions
      assert.ok(['ignore', 'fix', 'ticket'].includes(result.action));
      assert.ok(['low', 'medium', 'high', 'critical'].includes(result.severity));
      assert.ok(typeof result.explanation === 'string');
      assert.ok(typeof result.rootCause === 'string');

      const stats = getDoctorStats();
      assert.equal(stats.total, 1);
    });

    it('handles timeout failures', async () => {
      // Use unique error to avoid matching stale log entries
      const result = await diagnose(
        makeFailure({
          timedOut: true,
          error: `Timeout ${Date.now()}-${Math.random().toString(36).slice(2)}`,
        }),
      );

      // Timeouts can be transient (ignore) or escalated if recurring
      assert.ok(['ignore', 'ticket'].includes(result.action));
      assert.ok(typeof result.rootCause === 'string');
      assert.equal(result.recurring, false);
    });

    it('increments total stat across multiple calls', async () => {
      // Rate limit -> always ignored
      await diagnose(makeFailure({ error: '429 rate limit' }));
      // Unknown error -> depends on investigator
      await diagnose(makeFailure({ error: 'mystery error XYZ' }));
      // Timeout -> depends on investigator
      await diagnose(makeFailure({ timedOut: true, error: 'timeout' }));

      const stats = getDoctorStats();
      assert.equal(stats.total, 3);
      // At minimum, the rate limit one was ignored
      assert.ok(stats.ignored >= 1, 'at least the rate limit should be ignored');
      // Total actions should sum to total
      assert.equal(stats.fixes + stats.tickets + stats.ignored, stats.total);
    });

    it('detects recurring patterns and escalates', async () => {
      // Create identical failures to trigger recurring detection
      // Default recurringThreshold is 3
      // Use a truly unique error string with timestamp to avoid matching stale log entries
      const uniqueError = `Recurrence test ${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const failure = makeFailure({
        error: uniqueError,
        timedOut: true, // Use timeout so investigator short-circuits (fast)
      });

      // First three build up history
      const r1 = await diagnose(failure);
      assert.equal(r1.recurring, false);
      const r2 = await diagnose(failure);
      assert.equal(r2.recurring, false);
      const r3 = await diagnose(failure);
      assert.equal(r3.recurring, false);

      // Fourth sees 3 prior matching entries -> recurring
      const r4 = await diagnose(failure);
      assert.equal(r4.recurring, true);
      // Recurring should escalate — not ignore
      assert.ok(
        ['ticket', 'fix'].includes(r4.action),
        `recurring should escalate, got: ${r4.action}`,
      );
    });

    it('returns a well-shaped diagnosis object', async () => {
      const result = await diagnose(makeFailure());

      assert.ok('severity' in result);
      assert.ok('action' in result);
      assert.ok('explanation' in result);
      assert.ok('rootCause' in result);
      assert.ok('followUp' in result);
      assert.ok('investigatorDiagnosis' in result);
      assert.ok('recurring' in result);

      assert.ok(['low', 'medium', 'high', 'critical'].includes(result.severity));
      assert.ok(['ignore', 'fix', 'ticket'].includes(result.action));
    });
  });

  describe('resetDoctor()', () => {
    it('clears session stats', async () => {
      await diagnose(makeFailure({ error: '429 rate limit' }));
      assert.equal(getDoctorStats().total, 1);

      resetDoctor();
      assert.equal(getDoctorStats().total, 0);
    });
  });

  describe('initDoctor()', () => {
    it('initializes without error', () => {
      assert.doesNotThrow(() => {
        initDoctor();
      });
    });

    it('is idempotent — calling twice does not throw', () => {
      initDoctor();
      assert.doesNotThrow(() => {
        initDoctor();
      });
    });

    it('allows re-initialization after reset', () => {
      initDoctor();
      resetDoctor();
      assert.doesNotThrow(() => {
        initDoctor();
      });
    });
  });

  describe('isDoctorEnabled() with config overrides', () => {
    afterEach(() => {
      invalidateConfigCache();
    });

    it('returns false when doctor.enabled is explicitly false', () => {
      _setTestConfig({ doctor: { enabled: false } });
      assert.equal(isDoctorEnabled(), false);
    });

    it('returns true when doctor.enabled is true', () => {
      _setTestConfig({ doctor: { enabled: true } });
      assert.equal(isDoctorEnabled(), true);
    });

    it('returns true when doctor config is empty object', () => {
      _setTestConfig({ doctor: {} });
      assert.equal(isDoctorEnabled(), true);
    });

    it('returns true when doctor config is undefined', () => {
      _setTestConfig({ doctor: undefined });
      assert.equal(isDoctorEnabled(), true);
    });
  });

  describe('getDoctorStats() shape and isolation', () => {
    it('returns a copy — mutations do not affect internal state', () => {
      const stats1 = getDoctorStats();
      stats1.total = 999;
      stats1.fixes = 999;
      const stats2 = getDoctorStats();
      assert.equal(stats2.total, 0, 'internal state should not be mutated');
      assert.equal(stats2.fixes, 0);
    });

    it('has all expected numeric fields', () => {
      const stats = getDoctorStats();
      for (const key of ['total', 'fixes', 'tickets', 'investigations', 'ignored'] as const) {
        assert.equal(typeof stats[key], 'number', `${key} should be a number`);
      }
    });
  });

  describe('getDoctorLog()', () => {
    it('returns empty array before any diagnoses', () => {
      const log = getDoctorLog();
      assert.ok(Array.isArray(log));
      assert.equal(log.length, 0);
    });

    it('returns empty array with explicit limit', () => {
      const log = getDoctorLog(10);
      assert.ok(Array.isArray(log));
      assert.equal(log.length, 0);
    });

    it('returns empty array with limit of 0', () => {
      const log = getDoctorLog(0);
      assert.ok(Array.isArray(log));
      assert.equal(log.length, 0);
    });

    it('auto-initializes if not already initialized', () => {
      resetDoctor({ clearPersistent: true }); // ensure uninitialized state
      const log = getDoctorLog();
      assert.ok(Array.isArray(log));
    });

    it('returns entries after diagnose calls', async () => {
      await diagnose(makeFailure({ error: '429 rate limit' }));
      const log = getDoctorLog();
      assert.ok(log.length >= 1, 'should have at least one log entry');
      // Each entry should be an object with a 'ts' field
      assert.ok(typeof log[0] === 'object');
    });

    it('respects limit parameter', async () => {
      await diagnose(makeFailure({ error: '429 rate limit A' }));
      await diagnose(makeFailure({ error: '429 rate limit B' }));
      await diagnose(makeFailure({ error: '429 rate limit C' }));
      const log = getDoctorLog(1);
      assert.ok(log.length <= 1, 'should respect limit of 1');
    });

    it('returns newest first', async () => {
      await diagnose(makeFailure({ error: '429 rate limit first' }));
      await diagnose(makeFailure({ error: '429 rate limit second' }));
      const log = getDoctorLog();
      if (log.length >= 2) {
        const ts0 = new Date(log[0]['ts'] as string).getTime();
        const ts1 = new Date(log[1]['ts'] as string).getTime();
        assert.ok(ts0 >= ts1, 'newest entry should be first');
      }
    });
  });

  describe('resetDoctor() thorough', () => {
    it('can be called multiple times safely', () => {
      resetDoctor({ clearPersistent: true });
      resetDoctor({ clearPersistent: true });
      resetDoctor({ clearPersistent: true });
      const stats = getDoctorStats();
      assert.equal(stats.total, 0);
    });

    it('clears log entries', async () => {
      await diagnose(makeFailure({ error: '429 rate limit' }));
      assert.ok(getDoctorLog().length >= 1);
      resetDoctor({ clearPersistent: true });
      // After reset, getDoctorLog() re-initializes from the persistent log.
      // The test-only persistent clear keeps the sandbox isolated from prior runs.
      getDoctorLog();
      assert.equal(getDoctorLog().length, 0);
      assert.equal(getDoctorStats().total, 0);
    });
  });

  describe('diagnose() with categorized errors', () => {
    it('handles errorCategory field', async () => {
      const result = await diagnose(
        makeFailure({
          error: 'Failed to connect',
          errorCategory: 'network',
          errorDetail: 'ECONNREFUSED',
        }),
      );
      assert.ok(typeof result.explanation === 'string');
      assert.ok(typeof result.rootCause === 'string');
    });

    it('handles signal-terminated processes', async () => {
      const result = await diagnose(
        makeFailure({
          error: '',
          signal: 'SIGKILL',
          exitCode: null,
        }),
      );
      assert.ok(typeof result.explanation === 'string');
      assert.ok(['ignore', 'fix', 'ticket'].includes(result.action));
    });

    it('handles empty error with stderr', async () => {
      const result = await diagnose(
        makeFailure({
          error: '',
          stderr: 'fatal: not a git repository',
        }),
      );
      assert.ok(typeof result.explanation === 'string');
      assert.ok(result.explanation.length > 0);
    });
  });
});
