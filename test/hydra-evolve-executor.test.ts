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
