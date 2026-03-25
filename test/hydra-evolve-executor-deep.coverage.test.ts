/**
 * Deep coverage tests for lib/hydra-evolve-executor.ts — exercises additional code paths
 * in the evolve executor module.
 *
 * Complements hydra-evolve-executor.test.ts by testing more branches in:
 *   - formatDuration boundary conditions
 *   - recordInvestigation edge cases
 *   - executeAgentWithRetry disabled agent path (different agents)
 *   - DEFAULT_PHASE_TIMEOUTS invariants
 *   - EvolveResult type shape
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
  type EvolveResult,
} from '../lib/hydra-evolve-executor.ts';

// ── formatDuration — comprehensive boundary conditions ───────────────────────

describe('formatDuration — boundary conditions', () => {
  it('formats 0ms as 0s', () => {
    assert.equal(formatDuration(0), '0s');
  });

  it('formats 500ms as 0s (floor)', () => {
    assert.equal(formatDuration(500), '0s');
  });

  it('formats 999ms as 0s', () => {
    assert.equal(formatDuration(999), '0s');
  });

  it('formats 1000ms as 1s', () => {
    assert.equal(formatDuration(1000), '1s');
  });

  it('formats 59999ms as 59s', () => {
    assert.equal(formatDuration(59999), '59s');
  });

  it('formats 60000ms as 1m 0s', () => {
    assert.equal(formatDuration(60000), '1m 0s');
  });

  it('formats 61000ms as 1m 1s', () => {
    assert.equal(formatDuration(61000), '1m 1s');
  });

  it('formats 119000ms as 1m 59s', () => {
    assert.equal(formatDuration(119000), '1m 59s');
  });

  it('formats 3599000ms as 59m 59s', () => {
    assert.equal(formatDuration(3599000), '59m 59s');
  });

  it('formats 3600000ms as 1h 0m', () => {
    assert.equal(formatDuration(3600000), '1h 0m');
  });

  it('formats 3660000ms as 1h 1m', () => {
    assert.equal(formatDuration(3660000), '1h 1m');
  });

  it('formats 7200000ms as 2h 0m', () => {
    assert.equal(formatDuration(7200000), '2h 0m');
  });

  it('formats 7260000ms as 2h 1m', () => {
    assert.equal(formatDuration(7260000), '2h 1m');
  });

  it('formats 86400000ms (24h) as 24h 0m', () => {
    assert.equal(formatDuration(86400000), '24h 0m');
  });
});

// ── sessionInvestigations — multi-diagnosis scenarios ─────────────────────────

describe('sessionInvestigations — multi-diagnosis scenarios', () => {
  beforeEach(() => {
    sessionInvestigations.count = 0;
    sessionInvestigations.healed = 0;
    sessionInvestigations.diagnoses.length = 0;
  });

  it('tracks multiple diagnoses across different phases', () => {
    recordInvestigation('research', { diagnosis: 'transient', explanation: 'timeout' });
    recordInvestigation('test', {
      diagnosis: 'fixable',
      explanation: 'bad prompt',
      retryRecommendation: { retryPhase: true },
    });
    recordInvestigation('implement', { diagnosis: 'fundamental', explanation: 'missing dep' });

    assert.equal(sessionInvestigations.count, 3);
    assert.equal(sessionInvestigations.healed, 1); // only fixable+retryPhase
    assert.equal(sessionInvestigations.diagnoses.length, 3);

    assert.equal(sessionInvestigations.diagnoses[0].phase, 'research');
    assert.equal(sessionInvestigations.diagnoses[1].phase, 'test');
    assert.equal(sessionInvestigations.diagnoses[2].phase, 'implement');
  });

  it('does not increment healed for transient without retryPhase', () => {
    recordInvestigation('test', {
      diagnosis: 'transient',
      explanation: 'blip',
    });
    assert.equal(sessionInvestigations.healed, 0);
  });

  it('does not increment healed for fixable without retryPhase', () => {
    recordInvestigation('test', {
      diagnosis: 'fixable',
      explanation: 'issue',
    });
    assert.equal(sessionInvestigations.healed, 0);
  });

  it('handles both transient and fixable as healable with retryPhase', () => {
    recordInvestigation('a', {
      diagnosis: 'transient',
      explanation: 'x',
      retryRecommendation: { retryPhase: true },
    });
    recordInvestigation('b', {
      diagnosis: 'fixable',
      explanation: 'y',
      retryRecommendation: { retryPhase: true },
    });
    assert.equal(sessionInvestigations.healed, 2);
  });
});

// ── disabledAgents — various agent names ─────────────────────────────────────

describe('disabledAgents — multi-agent management', () => {
  beforeEach(() => {
    disabledAgents.clear();
  });

  it('can disable multiple agents', () => {
    disabledAgents.add('claude');
    disabledAgents.add('gemini');
    disabledAgents.add('codex');
    assert.equal(disabledAgents.size, 3);
    assert.ok(disabledAgents.has('claude'));
    assert.ok(disabledAgents.has('gemini'));
    assert.ok(disabledAgents.has('codex'));
  });

  it('does not duplicate entries', () => {
    disabledAgents.add('claude');
    disabledAgents.add('claude');
    assert.equal(disabledAgents.size, 1);
  });

  it('can remove agents', () => {
    disabledAgents.add('claude');
    disabledAgents.delete('claude');
    assert.ok(!disabledAgents.has('claude'));
    assert.equal(disabledAgents.size, 0);
  });
});

// ── executeAgentWithRetry — disabled agent returns for each agent ─────────────

describe('executeAgentWithRetry — disabled agent returns correct error message', () => {
  beforeEach(() => {
    disabledAgents.clear();
  });

  it('returns skipped for disabled claude', async () => {
    disabledAgents.add('claude');
    const result = await executeAgentWithRetry('claude', 'test prompt');
    assert.equal(result.ok, false);
    assert.equal(result.skipped, true);
    assert.match(result.error!, /claude.*disabled/);
    assert.equal(result.durationMs, 0);
    assert.equal(result.timedOut, false);
    assert.equal(result.output, '');
    assert.equal(result.stderr, '');
    assert.strictEqual(result.exitCode, null);
    assert.strictEqual(result.signal, null);
  });

  it('returns skipped for disabled gemini', async () => {
    disabledAgents.add('gemini');
    const result = await executeAgentWithRetry('gemini', 'test prompt');
    assert.equal(result.ok, false);
    assert.equal(result.skipped, true);
    assert.match(result.error!, /gemini.*disabled/);
  });

  it('returns skipped for disabled codex', async () => {
    disabledAgents.add('codex');
    const result = await executeAgentWithRetry('codex', 'test prompt');
    assert.equal(result.ok, false);
    assert.equal(result.skipped, true);
    assert.match(result.error!, /codex.*disabled/);
  });

  it('EvolveResult has expected shape for skipped agent', async () => {
    disabledAgents.add('codex');
    const result: EvolveResult = await executeAgentWithRetry('codex', 'test');
    // Verify all expected fields exist
    assert.equal(typeof result.ok, 'boolean');
    assert.equal(typeof result.output, 'string');
    assert.equal(typeof result.stderr, 'string');
    assert.equal(typeof result.durationMs, 'number');
    assert.equal(typeof result.timedOut, 'boolean');
    assert.equal(typeof result.skipped, 'boolean');
  });
});

// ── DEFAULT_PHASE_TIMEOUTS — ordering invariants ────────────────────────────

describe('DEFAULT_PHASE_TIMEOUTS — ordering invariants', () => {
  it('research <= deliberate', () => {
    assert.ok(
      DEFAULT_PHASE_TIMEOUTS.researchTimeoutMs <= DEFAULT_PHASE_TIMEOUTS.deliberateTimeoutMs,
    );
  });

  it('plan <= implement', () => {
    assert.ok(DEFAULT_PHASE_TIMEOUTS.planTimeoutMs <= DEFAULT_PHASE_TIMEOUTS.implementTimeoutMs);
  });

  it('test <= implement', () => {
    assert.ok(DEFAULT_PHASE_TIMEOUTS.testTimeoutMs <= DEFAULT_PHASE_TIMEOUTS.implementTimeoutMs);
  });

  it('analyze <= implement', () => {
    assert.ok(DEFAULT_PHASE_TIMEOUTS.analyzeTimeoutMs <= DEFAULT_PHASE_TIMEOUTS.implementTimeoutMs);
  });

  it('all values are round minutes (divisible by 60000)', () => {
    for (const [key, value] of Object.entries(DEFAULT_PHASE_TIMEOUTS)) {
      assert.equal(value % 60000, 0, `${key} = ${String(value)} is not a round minute`);
    }
  });

  it('keys match the standard evolve phase names', () => {
    const expected = new Set([
      'researchTimeoutMs',
      'deliberateTimeoutMs',
      'planTimeoutMs',
      'testTimeoutMs',
      'implementTimeoutMs',
      'analyzeTimeoutMs',
    ]);
    const actual = new Set(Object.keys(DEFAULT_PHASE_TIMEOUTS));
    assert.deepStrictEqual(actual, expected);
  });
});
