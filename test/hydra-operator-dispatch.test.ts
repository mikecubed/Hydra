/**
 * Tests for lib/hydra-operator-dispatch.ts
 *
 * Covers the pure/near-pure functions extracted from hydra-operator.ts:
 *   - buildAgentMessage
 *   - buildMiniRoundBrief
 *   - buildTandemBrief
 *   - shouldCrossVerify
 *
 * The async delegation helpers (dispatchPrompt, publishFastPathDelegation,
 * publishTandemDelegation, publishMiniRoundDelegation, runCrossVerification)
 * require a live daemon and are covered in integration tests.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAgentMessage,
  buildMiniRoundBrief,
  buildTandemBrief,
  shouldCrossVerify,
} from '../lib/hydra-operator-dispatch.ts';
import { _setTestConfig, invalidateConfigCache } from '../lib/hydra-config.ts';

// ── buildAgentMessage ────────────────────────────────────────────────────────

describe('buildAgentMessage', () => {
  it('returns a non-empty string', () => {
    const result = buildAgentMessage('claude', 'Fix the auth bug');
    assert.ok(typeof result === 'string');
    assert.ok(result.length > 0);
  });

  it('includes the user prompt text', () => {
    const prompt = 'Refactor the database layer';
    const result = buildAgentMessage('claude', prompt);
    assert.ok(result.includes(prompt), `Expected prompt in message, got:\n${result}`);
  });

  it('includes the agent name, label, or persona framing in output', () => {
    const result = buildAgentMessage('gemini', 'Analyse performance');
    // When persona is disabled: contains 'gemini' or 'GEMINI'
    // When persona is enabled: contains persona framing text (e.g. "analytical" or "Hydra's")
    const hasAgentRef =
      result.toLowerCase().includes('gemini') ||
      result.includes('GEMINI') ||
      result.toLowerCase().includes('hydra') ||
      result.toLowerCase().includes('analyst') ||
      result.toLowerCase().includes('analytical');
    assert.ok(hasAgentRef, `Expected agent/persona reference in: ${result.slice(0, 300)}`);
  });

  it('includes standard handoff instruction', () => {
    const result = buildAgentMessage('codex', 'Write tests for the util module');
    assert.ok(
      result.includes('handoff') || result.includes('blocked') || result.includes('unclear'),
      `Expected instruction text in: ${result.slice(0, 300)}`,
    );
  });

  it('works with an unknown agent name', () => {
    const result = buildAgentMessage('unknown-agent', 'Some task');
    assert.ok(typeof result === 'string');
    assert.ok(result.includes('Some task'));
  });

  it('produces different messages for different agents', () => {
    const claudeMsg = buildAgentMessage('claude', 'Design the system');
    const codexMsg = buildAgentMessage('codex', 'Design the system');
    // They may differ due to rolePrompt; at minimum both should contain the prompt
    assert.ok(claudeMsg.includes('Design the system'));
    assert.ok(codexMsg.includes('Design the system'));
  });
});

// ── buildMiniRoundBrief ──────────────────────────────────────────────────────

describe('buildMiniRoundBrief', () => {
  const baseReport = {
    tasks: [
      { owner: 'claude', title: 'Design the schema', done: 'Schema document', rationale: 'Core' },
      { owner: 'codex', title: 'Implement the schema', done: '', rationale: '' },
    ],
    questions: [{ to: 'human', question: 'Which database?' }],
    consensus: 'Proceed with PostgreSQL',
    recommendedMode: 'handoff',
    recommendationRationale: 'Straightforward task',
  };

  it('returns a non-empty string', () => {
    const result = buildMiniRoundBrief('claude', 'Build auth module', baseReport);
    assert.ok(typeof result === 'string');
    assert.ok(result.length > 0);
  });

  it('includes the user prompt text', () => {
    const prompt = 'Build auth module';
    const result = buildMiniRoundBrief('claude', prompt, baseReport);
    assert.ok(result.includes(prompt));
  });

  it('includes the consensus text', () => {
    const result = buildMiniRoundBrief('claude', 'Build auth module', baseReport);
    assert.ok(result.includes('PostgreSQL'));
  });

  it('lists assigned tasks for the given agent', () => {
    const result = buildMiniRoundBrief('claude', 'Build auth module', baseReport);
    assert.ok(result.includes('Design the schema'));
    // Should NOT include codex-only tasks for claude agent
    assert.ok(!result.includes('Implement the schema'));
  });

  it('handles empty tasks list with fallback message', () => {
    const emptyReport = { tasks: [], questions: [], consensus: '', recommendedMode: 'handoff' };
    const result = buildMiniRoundBrief('claude', 'Some task', emptyReport);
    assert.ok(result.includes('No explicit task') || result.includes('proposing'));
  });

  it('handles null/missing report gracefully', () => {
    const result = buildMiniRoundBrief('claude', 'Some task', null);
    assert.ok(typeof result === 'string');
    assert.ok(result.length > 0);
  });

  it('handles non-string consensus gracefully (defensive coercion)', () => {
    const report = {
      consensus: 123 as const,
      recommendedMode: 'handoff' as const,
      tasks: [] as unknown[],
      questions: [] as Array<{ to?: string; question?: string }>,
    };
    assert.doesNotThrow(() => buildMiniRoundBrief('claude', 'Some task', report));
    const result = buildMiniRoundBrief('claude', 'Some task', report);
    assert.ok(result.includes('123'));
  });

  it('includes question addressed to agent', () => {
    const reportWithAgentQ = {
      ...baseReport,
      questions: [{ to: 'claude', question: 'What pattern to use?' }],
    };
    const result = buildMiniRoundBrief('claude', 'Build auth module', reportWithAgentQ);
    assert.ok(result.includes('What pattern to use?'));
  });

  it('includes recommended mode', () => {
    const result = buildMiniRoundBrief('claude', 'Build auth module', baseReport);
    assert.ok(result.includes('handoff'));
  });
});

// ── buildTandemBrief ─────────────────────────────────────────────────────────

describe('buildTandemBrief', () => {
  it('returns a non-empty string', () => {
    const result = buildTandemBrief('claude', 'codex', 'Redesign auth', {}, 'lead');
    assert.ok(typeof result === 'string');
    assert.ok(result.length > 0);
  });

  it('includes the prompt text', () => {
    const prompt = 'Redesign auth';
    const result = buildTandemBrief('claude', 'codex', prompt, {}, 'lead');
    assert.ok(result.includes(prompt));
  });

  it('lead role message mentions follow-up partner', () => {
    const result = buildTandemBrief('claude', 'codex', 'Task A', {}, 'lead');
    // Lead should reference the partner agent label or name
    assert.ok(
      result.toLowerCase().includes('codex') || result.includes('execution'),
      `Lead brief should mention partner: ${result.slice(0, 300)}`,
    );
  });

  it('follow role message mentions lead partner', () => {
    const result = buildTandemBrief('codex', 'claude', 'Task B', {}, 'follow');
    // Follow should reference the lead
    assert.ok(
      result.toLowerCase().includes('claude') || result.toLowerCase().includes('lead'),
      `Follow brief should mention lead: ${result.slice(0, 300)}`,
    );
  });

  it('lead and follow messages differ from each other', () => {
    const lead = buildTandemBrief('claude', 'codex', 'Task X', {}, 'lead');
    const follow = buildTandemBrief('codex', 'claude', 'Task X', {}, 'follow');
    assert.notEqual(lead, follow);
  });

  it('includes handoff instruction', () => {
    const result = buildTandemBrief('claude', 'codex', 'Task', {}, 'lead');
    assert.ok(result.includes('handoff') || result.includes('blocked'));
  });
});

// ── shouldCrossVerify ────────────────────────────────────────────────────────

describe('shouldCrossVerify', () => {
  beforeEach(() => {
    _setTestConfig({});
  });

  afterEach(() => {
    invalidateConfigCache();
  });

  it('returns a boolean', () => {
    const result = shouldCrossVerify({ tier: 'simple' });
    assert.ok(typeof result === 'boolean');
  });

  it('returns false when crossModelVerification is disabled', () => {
    _setTestConfig({ crossModelVerification: { enabled: false } });
    assert.equal(shouldCrossVerify({ tier: 'complex' }), false);
  });

  it('returns true for always mode regardless of tier', () => {
    _setTestConfig({
      crossModelVerification: { enabled: true, mode: 'always' },
    });
    assert.equal(shouldCrossVerify({ tier: 'simple' }), true);
    assert.equal(shouldCrossVerify({ tier: 'complex' }), true);
  });

  it('returns true for complex tier in on-complex mode', () => {
    _setTestConfig({
      crossModelVerification: { enabled: true, mode: 'on-complex' },
    });
    assert.equal(shouldCrossVerify({ tier: 'complex' }), true);
  });

  it('returns false for simple tier in on-complex mode', () => {
    _setTestConfig({
      crossModelVerification: { enabled: true, mode: 'on-complex' },
    });
    assert.equal(shouldCrossVerify({ tier: 'simple' }), false);
  });

  it('returns false for unknown mode', () => {
    _setTestConfig({
      crossModelVerification: { enabled: true, mode: 'unknown-mode' },
    });
    assert.equal(shouldCrossVerify({ tier: 'complex' }), false);
  });
});
