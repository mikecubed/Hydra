/**
 * Tests for hydra-provider-usage.ts — provider token tracking and cost estimation.
 *
 * Tests pure functions (estimateCost, estimateCostGeneric) and stateful tracking
 * (recordProviderUsage, getProviderUsage, getProviderSummary, resetSessionUsage).
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  estimateCost,
  estimateCostGeneric,
  recordProviderUsage,
  getProviderUsage,
  getProviderSummary,
  getExternalSummary,
  resetSessionUsage,
  COST_PER_1K,
} from '../lib/hydra-provider-usage.ts';

// ── estimateCost ────────────────────────────────────────────────────────────

describe('estimateCost', () => {
  it('returns 0 for null usage', () => {
    assert.equal(estimateCost('gpt-4o', null), 0);
  });

  it('returns 0 for unknown model', () => {
    const cost = estimateCost('nonexistent-model-xyz', { prompt_tokens: 1000, completion_tokens: 500 });
    assert.equal(cost, 0);
  });

  it('calculates cost for a known model using prompt_tokens/completion_tokens', () => {
    // Find a model that exists in the cost table
    const knownModel = Object.keys(COST_PER_1K)[0];
    if (knownModel == null) {
      // Skip if no models in cost table (unlikely)
      return;
    }
    const rates = (COST_PER_1K as Record<string, { input: number; output: number }>)[knownModel];
    const cost = estimateCost(knownModel, { prompt_tokens: 1000, completion_tokens: 1000 });
    const expected = rates.input + rates.output; // 1000/1000 * rate = rate
    assert.ok(Math.abs(cost - expected) < 0.0001, `expected ~${String(expected)}, got ${String(cost)}`);
  });

  it('calculates cost using inputTokens/outputTokens aliases', () => {
    const knownModel = Object.keys(COST_PER_1K)[0];
    if (knownModel == null) return;
    const rates = (COST_PER_1K as Record<string, { input: number; output: number }>)[knownModel];
    const cost = estimateCost(knownModel, { inputTokens: 2000, outputTokens: 500 });
    const expected = (2000 / 1000) * rates.input + (500 / 1000) * rates.output;
    assert.ok(Math.abs(cost - expected) < 0.0001);
  });

  it('returns 0 for zero tokens', () => {
    const knownModel = Object.keys(COST_PER_1K)[0];
    if (knownModel == null) return;
    const cost = estimateCost(knownModel, { prompt_tokens: 0, completion_tokens: 0 });
    assert.equal(cost, 0);
  });

  it('handles missing token fields gracefully (defaults to 0)', () => {
    const knownModel = Object.keys(COST_PER_1K)[0];
    if (knownModel == null) return;
    const cost = estimateCost(knownModel, {});
    assert.equal(cost, 0);
  });
});

// ── estimateCostGeneric ─────────────────────────────────────────────────────

describe('estimateCostGeneric', () => {
  it('calculates cost for openai provider', () => {
    const cost = estimateCostGeneric('openai', 1000, 1000);
    // openai rates: input 0.002, output 0.008 per 1K
    const expected = (1000 / 1000) * 0.002 + (1000 / 1000) * 0.008;
    assert.ok(Math.abs(cost - expected) < 0.0001);
  });

  it('calculates cost for anthropic provider', () => {
    const cost = estimateCostGeneric('anthropic', 1000, 1000);
    // anthropic rates: input 0.005, output 0.025 per 1K
    const expected = (1000 / 1000) * 0.005 + (1000 / 1000) * 0.025;
    assert.ok(Math.abs(cost - expected) < 0.0001);
  });

  it('returns 0 for unknown provider', () => {
    assert.equal(estimateCostGeneric('unknown-provider', 1000, 1000), 0);
  });

  it('returns 0 for zero tokens', () => {
    assert.equal(estimateCostGeneric('openai', 0, 0), 0);
  });

  it('scales linearly with token count', () => {
    const cost1 = estimateCostGeneric('openai', 1000, 0);
    const cost2 = estimateCostGeneric('openai', 2000, 0);
    assert.ok(Math.abs(cost2 - 2 * cost1) < 0.0001);
  });
});

// ── recordProviderUsage + getProviderUsage ──────────────────────────────────

describe('recordProviderUsage and getProviderUsage', () => {
  beforeEach(() => {
    resetSessionUsage();
  });

  it('accumulates tokens on session and today counters', () => {
    recordProviderUsage('openai', { inputTokens: 100, outputTokens: 50 });
    const usage = getProviderUsage();
    assert.equal(usage.openai.session.inputTokens, 100);
    assert.equal(usage.openai.session.outputTokens, 50);
    assert.equal(usage.openai.session.calls, 1);
    assert.equal(usage.openai.today.inputTokens, 100);
    assert.equal(usage.openai.today.outputTokens, 50);
    assert.equal(usage.openai.today.calls, 1);
  });

  it('accumulates across multiple calls', () => {
    recordProviderUsage('anthropic', { inputTokens: 100, outputTokens: 50 });
    recordProviderUsage('anthropic', { inputTokens: 200, outputTokens: 100 });
    const usage = getProviderUsage();
    assert.equal(usage.anthropic.session.inputTokens, 300);
    assert.equal(usage.anthropic.session.outputTokens, 150);
    assert.equal(usage.anthropic.session.calls, 2);
  });

  it('ignores unknown providers', () => {
    // Should not throw
    recordProviderUsage('unknown-provider', { inputTokens: 100, outputTokens: 50 });
    const usage = getProviderUsage();
    // Verify known providers are unaffected
    assert.equal(usage.openai.session.calls, 0);
    assert.equal(usage.anthropic.session.calls, 0);
    assert.equal(usage.google.session.calls, 0);
  });

  it('estimates cost from model when cost not provided', () => {
    const knownModel = Object.keys(COST_PER_1K)[0];
    if (knownModel == null) return;
    recordProviderUsage('openai', { inputTokens: 1000, outputTokens: 500, model: knownModel });
    const usage = getProviderUsage();
    assert.ok(usage.openai.session.cost >= 0);
  });

  it('uses provided cost when given', () => {
    recordProviderUsage('openai', { inputTokens: 100, outputTokens: 50, cost: 0.42 });
    const usage = getProviderUsage();
    assert.ok(Math.abs(usage.openai.session.cost - 0.42) < 0.0001);
  });

  it('returns snapshot (not reference to internal state)', () => {
    recordProviderUsage('openai', { inputTokens: 100 });
    const usage1 = getProviderUsage();
    recordProviderUsage('openai', { inputTokens: 200 });
    const usage2 = getProviderUsage();
    // usage1 should not have been mutated
    assert.equal(usage1.openai.session.inputTokens, 100);
    assert.equal(usage2.openai.session.inputTokens, 300);
  });
});

// ── resetSessionUsage ───────────────────────────────────────────────────────

describe('resetSessionUsage', () => {
  beforeEach(() => {
    resetSessionUsage();
  });

  it('clears session counters', () => {
    recordProviderUsage('openai', { inputTokens: 100, outputTokens: 50 });
    resetSessionUsage();
    const usage = getProviderUsage();
    assert.equal(usage.openai.session.inputTokens, 0);
    assert.equal(usage.openai.session.outputTokens, 0);
    assert.equal(usage.openai.session.cost, 0);
    assert.equal(usage.openai.session.calls, 0);
  });

  it('preserves today counters', () => {
    recordProviderUsage('openai', { inputTokens: 100, outputTokens: 50 });
    const beforeReset = getProviderUsage();
    const todayBefore = beforeReset.openai.today.inputTokens;
    resetSessionUsage();
    const afterReset = getProviderUsage();
    assert.equal(afterReset.openai.today.inputTokens, todayBefore);
  });
});

// ── getProviderSummary ──────────────────────────────────────────────────────

describe('getProviderSummary', () => {
  beforeEach(() => {
    resetSessionUsage();
  });

  it('returns empty array when no calls recorded', () => {
    const lines = getProviderSummary();
    assert.deepEqual(lines, []);
  });

  it('returns formatted lines for providers with calls', () => {
    recordProviderUsage('openai', { inputTokens: 5000, outputTokens: 3000 });
    const lines = getProviderSummary();
    assert.ok(lines.length >= 1);
    assert.ok(lines[0].startsWith('openai:'));
    assert.ok(lines[0].includes('K'), 'should format thousands as K');
  });

  it('formats millions correctly', () => {
    recordProviderUsage('openai', { inputTokens: 500_000, outputTokens: 600_000 });
    const lines = getProviderSummary();
    assert.ok(lines[0].includes('M'), 'should format millions as M');
  });

  it('includes cost when > 0', () => {
    recordProviderUsage('openai', { inputTokens: 1000, outputTokens: 500, cost: 1.23 });
    const lines = getProviderSummary();
    assert.ok(lines[0].includes('$1.23'));
  });

  it('shows ~ when cost is 0', () => {
    recordProviderUsage('openai', { inputTokens: 100, outputTokens: 50, cost: 0 });
    const lines = getProviderSummary();
    assert.ok(lines[0].includes('~'), 'should show ~ for zero cost');
  });
});

// ── getExternalSummary ──────────────────────────────────────────────────────

describe('getExternalSummary', () => {
  it('returns empty array when no external data is set', () => {
    const lines = getExternalSummary();
    assert.deepEqual(lines, []);
  });
});

// ── COST_PER_1K ─────────────────────────────────────────────────────────────

describe('COST_PER_1K', () => {
  it('is a non-empty object', () => {
    assert.ok(typeof COST_PER_1K === 'object');
    assert.ok(Object.keys(COST_PER_1K).length > 0, 'cost table should have entries');
  });

  it('all entries have input and output rates', () => {
    for (const [model, rates] of Object.entries(COST_PER_1K)) {
      const r = rates as { input: number; output: number };
      assert.ok(typeof r.input === 'number', `${model} missing input rate`);
      assert.ok(typeof r.output === 'number', `${model} missing output rate`);
      assert.ok(r.input >= 0, `${model} has negative input rate`);
      assert.ok(r.output >= 0, `${model} has negative output rate`);
    }
  });
});
