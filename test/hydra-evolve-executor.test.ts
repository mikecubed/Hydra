/**
 * Tests for lib/hydra-evolve-executor.ts
 *
 * Covers the extractable behaviors of the evolve executor:
 *   - formatDuration   — pure duration formatter
 *   - DEFAULT_PHASE_TIMEOUTS — shape / values
 *   - sessionInvestigations / recordInvestigation — counter tracking
 *   - disabledAgents  — mutable Set, exported for main() coordination
 *   - executeAgentWithRetry — skips disabled agents immediately (fast path)
 *   - PROTECTED_FILES — executor module is included in evolve guardrails
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatDuration,
  DEFAULT_PHASE_TIMEOUTS,
  sessionInvestigations,
  recordInvestigation,
  disabledAgents,
  executeAgentWithRetry,
} from '../lib/hydra-evolve-executor.ts';
import { PROTECTED_FILES } from '../lib/hydra-evolve-guardrails.ts';

// ── formatDuration ───────────────────────────────────────────────────────────

describe('formatDuration', () => {
  it('formats sub-minute durations in seconds', () => {
    assert.strictEqual(formatDuration(0), '0s');
    assert.strictEqual(formatDuration(1000), '1s');
    assert.strictEqual(formatDuration(59_000), '59s');
  });

  it('formats durations of exactly one minute', () => {
    assert.strictEqual(formatDuration(60_000), '1m 0s');
  });

  it('formats multi-minute durations', () => {
    assert.strictEqual(formatDuration(90_000), '1m 30s');
    assert.strictEqual(formatDuration(3_600_000), '1h 0m');
  });

  it('truncates sub-second precision', () => {
    // 1500ms → 1s (floor)
    assert.strictEqual(formatDuration(1500), '1s');
  });
});

// ── DEFAULT_PHASE_TIMEOUTS ───────────────────────────────────────────────────

describe('DEFAULT_PHASE_TIMEOUTS', () => {
  it('has all expected phase keys', () => {
    const keys = [
      'researchTimeoutMs',
      'deliberateTimeoutMs',
      'planTimeoutMs',
      'testTimeoutMs',
      'implementTimeoutMs',
      'analyzeTimeoutMs',
    ];
    for (const key of keys) {
      assert.ok(key in DEFAULT_PHASE_TIMEOUTS, `Missing key: ${key}`);
    }
  });

  it('all timeout values are positive numbers', () => {
    for (const [key, value] of Object.entries(DEFAULT_PHASE_TIMEOUTS)) {
      assert.ok(typeof value === 'number' && value > 0, `${key} should be a positive number`);
    }
  });

  it('research timeout is shorter than implement timeout', () => {
    assert.ok(DEFAULT_PHASE_TIMEOUTS.researchTimeoutMs < DEFAULT_PHASE_TIMEOUTS.implementTimeoutMs);
  });
});

// ── sessionInvestigations / recordInvestigation ──────────────────────────────

describe('sessionInvestigations + recordInvestigation', () => {
  beforeEach(() => {
    // Reset the shared state before each test
    sessionInvestigations.count = 0;
    sessionInvestigations.healed = 0;
    sessionInvestigations.diagnoses.length = 0;
  });

  it('starts with zeroed counters', () => {
    assert.strictEqual(sessionInvestigations.count, 0);
    assert.strictEqual(sessionInvestigations.healed, 0);
    assert.deepStrictEqual(sessionInvestigations.diagnoses, []);
  });

  it('increments count on each call', () => {
    recordInvestigation('test', { diagnosis: 'transient', explanation: 'timeout' });
    recordInvestigation('analyze', { diagnosis: 'fixable', explanation: 'bad prompt' });
    assert.strictEqual(sessionInvestigations.count, 2);
  });

  it('records diagnosis details', () => {
    recordInvestigation('implement', { diagnosis: 'fundamental', explanation: 'missing dep' });
    assert.strictEqual(sessionInvestigations.diagnoses.length, 1);
    assert.strictEqual(sessionInvestigations.diagnoses[0].phase, 'implement');
    assert.strictEqual(sessionInvestigations.diagnoses[0].diagnosis, 'fundamental');
    assert.strictEqual(sessionInvestigations.diagnoses[0].explanation, 'missing dep');
  });

  it('increments healed when fixable + retryPhase', () => {
    recordInvestigation('test', {
      diagnosis: 'fixable',
      explanation: 'bad prompt',
      retryRecommendation: { retryPhase: true },
    });
    assert.strictEqual(sessionInvestigations.healed, 1);
  });

  it('increments healed for transient + retryPhase', () => {
    recordInvestigation('test', {
      diagnosis: 'transient',
      explanation: 'network blip',
      retryRecommendation: { retryPhase: true },
    });
    assert.strictEqual(sessionInvestigations.healed, 1);
  });

  it('does NOT increment healed for fundamental', () => {
    recordInvestigation('test', {
      diagnosis: 'fundamental',
      explanation: 'bad env',
      retryRecommendation: { retryPhase: true },
    });
    assert.strictEqual(sessionInvestigations.healed, 0);
  });

  it('does NOT increment healed when retryPhase is false', () => {
    recordInvestigation('test', {
      diagnosis: 'fixable',
      explanation: 'prompt issue',
      retryRecommendation: { retryPhase: false },
    });
    assert.strictEqual(sessionInvestigations.healed, 0);
  });
});

// ── disabledAgents ───────────────────────────────────────────────────────────

describe('disabledAgents', () => {
  beforeEach(() => {
    disabledAgents.clear();
  });

  it('is a Set', () => {
    assert.ok(disabledAgents instanceof Set);
  });

  it('starts empty after clear', () => {
    assert.strictEqual(disabledAgents.size, 0);
  });

  it('can add and check agents', () => {
    disabledAgents.add('codex');
    assert.ok(disabledAgents.has('codex'));
    assert.ok(!disabledAgents.has('claude'));
  });
});

// ── executeAgentWithRetry — disabled agent fast path ─────────────────────────

describe('executeAgentWithRetry — disabled agent fast path', () => {
  beforeEach(() => {
    disabledAgents.clear();
  });

  it('returns a skipped result immediately for a disabled agent', async () => {
    disabledAgents.add('codex');
    const result = await executeAgentWithRetry('codex', 'any prompt');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.skipped, true);
    assert.ok(result.error?.includes('disabled'));
  });

  it('does not call through to agent for disabled agent (durationMs is 0)', async () => {
    disabledAgents.add('gemini');
    const result = await executeAgentWithRetry('gemini', 'any prompt');
    assert.strictEqual(result.durationMs, 0);
    assert.strictEqual(result.timedOut, false);
  });
});

// ── PROTECTED_FILES — executor module self-modification guard ─────────────────

describe('PROTECTED_FILES guardrail for executor module', () => {
  it('includes lib/hydra-evolve-executor.ts', () => {
    assert.ok(
      PROTECTED_FILES.has('lib/hydra-evolve-executor.ts'),
      'hydra-evolve-executor.ts must be in PROTECTED_FILES to prevent self-modification',
    );
  });

  it('still includes lib/hydra-evolve.ts', () => {
    assert.ok(PROTECTED_FILES.has('lib/hydra-evolve.ts'));
  });
});

// ── formatDuration edge cases ────────────────────────────────────────────────

describe('formatDuration — additional edge cases', () => {
  it('formats negative values gracefully (floor to 0s or negative)', () => {
    // Math.floor(-1) = -1, but negative ms is unusual — just verify no crash
    const result = formatDuration(-1);
    assert.equal(typeof result, 'string');
  });

  it('formats exactly 1 hour', () => {
    assert.strictEqual(formatDuration(3_600_000), '1h 0m');
  });

  it('formats 1 hour 30 minutes', () => {
    assert.strictEqual(formatDuration(5_400_000), '1h 30m');
  });

  it('formats multi-hour durations', () => {
    assert.strictEqual(formatDuration(7_200_000), '2h 0m');
  });

  it('formats 2 hours 15 minutes', () => {
    assert.strictEqual(formatDuration(8_100_000), '2h 15m');
  });

  it('formats large values (24h)', () => {
    assert.strictEqual(formatDuration(86_400_000), '24h 0m');
  });

  it('rounds down milliseconds within a second', () => {
    assert.strictEqual(formatDuration(999), '0s');
    assert.strictEqual(formatDuration(1001), '1s');
  });
});

// ── DEFAULT_PHASE_TIMEOUTS — additional assertions ──────────────────────────

describe('DEFAULT_PHASE_TIMEOUTS — additional checks', () => {
  it('all values are at least 1 minute (60_000 ms)', () => {
    for (const [key, value] of Object.entries(DEFAULT_PHASE_TIMEOUTS)) {
      assert.ok(value >= 60_000, `${key} should be at least 60s, got ${String(value)}`);
    }
  });

  it('has exactly 6 phase timeout keys', () => {
    assert.equal(Object.keys(DEFAULT_PHASE_TIMEOUTS).length, 6);
  });

  it('plan timeout is shorter than or equal to implement timeout', () => {
    assert.ok(DEFAULT_PHASE_TIMEOUTS.planTimeoutMs <= DEFAULT_PHASE_TIMEOUTS.implementTimeoutMs);
  });

  it('implement timeout is the longest', () => {
    const max = Math.max(...Object.values(DEFAULT_PHASE_TIMEOUTS));
    assert.equal(max, DEFAULT_PHASE_TIMEOUTS.implementTimeoutMs);
  });
});

// ── disabledAgents — additional operations ──────────────────────────────────

describe('disabledAgents — extended operations', () => {
  beforeEach(() => {
    disabledAgents.clear();
  });

  it('supports adding multiple agents', () => {
    disabledAgents.add('codex');
    disabledAgents.add('gemini');
    assert.equal(disabledAgents.size, 2);
    assert.ok(disabledAgents.has('codex'));
    assert.ok(disabledAgents.has('gemini'));
  });

  it('adding the same agent twice keeps size at 1', () => {
    disabledAgents.add('claude');
    disabledAgents.add('claude');
    assert.equal(disabledAgents.size, 1);
  });

  it('delete removes a specific agent', () => {
    disabledAgents.add('codex');
    disabledAgents.add('gemini');
    disabledAgents.delete('codex');
    assert.equal(disabledAgents.size, 1);
    assert.ok(!disabledAgents.has('codex'));
    assert.ok(disabledAgents.has('gemini'));
  });

  it('is iterable', () => {
    disabledAgents.add('claude');
    disabledAgents.add('codex');
    const names = [...disabledAgents];
    assert.equal(names.length, 2);
    assert.ok(names.includes('claude'));
    assert.ok(names.includes('codex'));
  });
});

// ── recordInvestigation — edge cases ────────────────────────────────────────

describe('recordInvestigation — edge cases', () => {
  beforeEach(() => {
    sessionInvestigations.count = 0;
    sessionInvestigations.healed = 0;
    sessionInvestigations.diagnoses.length = 0;
  });

  it('handles missing retryRecommendation gracefully', () => {
    recordInvestigation('test', { diagnosis: 'fixable', explanation: 'no retry field' });
    assert.strictEqual(sessionInvestigations.count, 1);
    assert.strictEqual(sessionInvestigations.healed, 0);
  });

  it('handles multiple investigations in sequence', () => {
    for (let i = 0; i < 5; i++) {
      recordInvestigation('test', {
        diagnosis: 'transient',
        explanation: `attempt ${String(i)}`,
        retryRecommendation: { retryPhase: true },
      });
    }
    assert.strictEqual(sessionInvestigations.count, 5);
    assert.strictEqual(sessionInvestigations.healed, 5);
    assert.strictEqual(sessionInvestigations.diagnoses.length, 5);
  });
});
