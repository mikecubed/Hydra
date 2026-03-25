/**
 * Tests for lib/hydra-evolve-investigator.ts
 *
 * Covers:
 *   - parseInvestigatorResponse — PURE JSON parser (various formats)
 *   - getInvestigatorStats — returns counter object
 *   - initInvestigator / resetInvestigator — state management
 *   - isInvestigatorAvailable — checks config + env
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseInvestigatorResponse,
  initInvestigator,
  resetInvestigator,
  isInvestigatorAvailable,
  getInvestigatorStats,
} from '../lib/hydra-evolve-investigator.ts';
import { _setTestConfig, invalidateConfigCache } from '../lib/hydra-config.ts';

// ── parseInvestigatorResponse ────────────────────────────────────────────────

describe('parseInvestigatorResponse', () => {
  it('parses clean JSON with all fields', () => {
    const raw = JSON.stringify({
      diagnosis: 'transient',
      explanation: 'Rate limit hit',
      rootCause: 'API 429',
      corrective: null,
      retryRecommendation: {
        retryPhase: true,
        modifiedPrompt: null,
        preamble: null,
        retryAgent: null,
      },
    });
    const result = parseInvestigatorResponse(raw);
    assert.equal(result.diagnosis, 'transient');
    assert.equal(result.explanation, 'Rate limit hit');
    assert.equal(result.rootCause, 'API 429');
    assert.equal(result.corrective, null);
    assert.equal(result.retryRecommendation.retryPhase, true);
    assert.equal(result.retryRecommendation.modifiedPrompt, null);
  });

  it('parses JSON wrapped in markdown code fences', () => {
    const raw =
      '```json\n{"diagnosis":"fixable","explanation":"bad import","rootCause":"missing module","corrective":"add import","retryRecommendation":{"retryPhase":true,"modifiedPrompt":"Add import for fs","preamble":null,"retryAgent":null}}\n```';
    const result = parseInvestigatorResponse(raw);
    assert.equal(result.diagnosis, 'fixable');
    assert.equal(result.explanation, 'bad import');
    assert.equal(result.corrective, 'add import');
    assert.equal(result.retryRecommendation.retryPhase, true);
    assert.equal(result.retryRecommendation.modifiedPrompt, 'Add import for fs');
  });

  it('parses JSON wrapped in plain code fences (no language tag)', () => {
    const raw =
      '```\n{"diagnosis":"fundamental","explanation":"impossible","rootCause":"no dep","corrective":null,"retryRecommendation":{"retryPhase":false,"modifiedPrompt":null,"preamble":null,"retryAgent":null}}\n```';
    const result = parseInvestigatorResponse(raw);
    assert.equal(result.diagnosis, 'fundamental');
    assert.equal(result.retryRecommendation.retryPhase, false);
  });

  it('defaults diagnosis to "fundamental" when field is missing', () => {
    const raw = JSON.stringify({
      explanation: 'something went wrong',
      rootCause: 'unknown reason',
    });
    const result = parseInvestigatorResponse(raw);
    assert.equal(result.diagnosis, 'fundamental');
  });

  it('defaults explanation to "No explanation provided" when missing', () => {
    const raw = JSON.stringify({ diagnosis: 'transient' });
    const result = parseInvestigatorResponse(raw);
    assert.equal(result.explanation, 'No explanation provided');
  });

  it('defaults rootCause to "Unknown" when missing', () => {
    const raw = JSON.stringify({ diagnosis: 'transient', explanation: 'timeout' });
    const result = parseInvestigatorResponse(raw);
    assert.equal(result.rootCause, 'Unknown');
  });

  it('defaults retryRecommendation fields when missing', () => {
    const raw = JSON.stringify({
      diagnosis: 'fixable',
      explanation: 'prompt issue',
      rootCause: 'bad instructions',
    });
    const result = parseInvestigatorResponse(raw);
    assert.equal(result.retryRecommendation.retryPhase, false);
    assert.equal(result.retryRecommendation.modifiedPrompt, null);
    assert.equal(result.retryRecommendation.preamble, null);
    assert.equal(result.retryRecommendation.retryAgent, null);
  });

  it('defaults corrective to null when field is non-string', () => {
    const raw = JSON.stringify({
      diagnosis: 'fixable',
      explanation: 'test',
      rootCause: 'test',
      corrective: 42, // not a string
    });
    const result = parseInvestigatorResponse(raw);
    assert.equal(result.corrective, null);
  });

  it('handles retryAgent when present', () => {
    const raw = JSON.stringify({
      diagnosis: 'fixable',
      explanation: 'agent mismatch',
      rootCause: 'codex confused',
      corrective: 'try claude instead',
      retryRecommendation: {
        retryPhase: true,
        modifiedPrompt: null,
        preamble: 'Use careful analysis',
        retryAgent: 'claude',
      },
    });
    const result = parseInvestigatorResponse(raw);
    assert.equal(result.retryRecommendation.retryAgent, 'claude');
    assert.equal(result.retryRecommendation.preamble, 'Use careful analysis');
  });

  it('returns fallback for completely unparseable input', () => {
    const result = parseInvestigatorResponse('this is not json at all');
    assert.equal(result.diagnosis, 'fundamental');
    assert.equal(result.explanation, 'Investigator returned unparseable response');
    assert.ok(result.rootCause.includes('this is not json'));
    assert.equal(result.retryRecommendation.retryPhase, false);
  });

  it('returns fallback for empty string', () => {
    const result = parseInvestigatorResponse('');
    assert.equal(result.diagnosis, 'fundamental');
    assert.equal(result.explanation, 'Investigator returned unparseable response');
  });

  it('truncates rootCause to 200 chars on parse failure', () => {
    const longGarbage = 'x'.repeat(500);
    const result = parseInvestigatorResponse(longGarbage);
    assert.equal(result.rootCause.length, 200);
  });

  it('handles JSON with extra whitespace', () => {
    const raw =
      '  \n\n  {"diagnosis":"transient","explanation":"flaky","rootCause":"network","corrective":null,"retryRecommendation":{"retryPhase":true,"modifiedPrompt":null,"preamble":null,"retryAgent":null}}  \n\n  ';
    const result = parseInvestigatorResponse(raw);
    assert.equal(result.diagnosis, 'transient');
    assert.equal(result.retryRecommendation.retryPhase, true);
  });

  it('handles non-boolean retryPhase by defaulting to false', () => {
    const raw = JSON.stringify({
      diagnosis: 'fixable',
      explanation: 'test',
      rootCause: 'test',
      retryRecommendation: {
        retryPhase: 'yes', // not a boolean
      },
    });
    const result = parseInvestigatorResponse(raw);
    assert.equal(result.retryRecommendation.retryPhase, false);
  });

  it('handles empty object', () => {
    const result = parseInvestigatorResponse('{}');
    assert.equal(result.diagnosis, 'fundamental');
    assert.equal(result.explanation, 'No explanation provided');
    assert.equal(result.rootCause, 'Unknown');
    assert.equal(result.corrective, null);
    assert.equal(result.retryRecommendation.retryPhase, false);
  });
});

// ── initInvestigator / resetInvestigator ──────────────────────────────────────

describe('initInvestigator / resetInvestigator', () => {
  beforeEach(() => {
    _setTestConfig({ evolve: { investigator: { enabled: true, model: 'test-model' } } });
  });

  afterEach(() => {
    resetInvestigator();
    invalidateConfigCache();
  });

  it('initializes without error', () => {
    assert.doesNotThrow(() => {
      initInvestigator();
    });
  });

  it('accepts overrides for model', () => {
    initInvestigator({ model: 'custom-model' });
    // Verify via stats which reads from config
    const stats = getInvestigatorStats();
    assert.equal(typeof stats.tokenBudgetMax, 'number');
  });

  it('accepts overrides for maxTokensBudget', () => {
    initInvestigator({ maxTokensBudget: 10_000 });
    const stats = getInvestigatorStats();
    assert.equal(stats.tokenBudgetMax, 10_000);
  });

  it('ignores zero maxTokensBudget override', () => {
    initInvestigator({ maxTokensBudget: 0 });
    const stats = getInvestigatorStats();
    // Should use the default (50_000) not 0
    assert.ok(stats.tokenBudgetMax > 0);
  });

  it('ignores NaN maxTokensBudget override', () => {
    initInvestigator({ maxTokensBudget: Number.NaN });
    const stats = getInvestigatorStats();
    assert.ok(stats.tokenBudgetMax > 0);
  });

  it('ignores empty string model override', () => {
    initInvestigator({ model: '' });
    // Should not throw
    const stats = getInvestigatorStats();
    assert.equal(typeof stats.tokenBudgetMax, 'number');
  });

  it('resetInvestigator clears stats', () => {
    initInvestigator();
    resetInvestigator();
    // After reset, config is null so stats will re-load from config
    const stats = getInvestigatorStats();
    assert.equal(stats.investigations, 0);
    assert.equal(stats.healed, 0);
    assert.equal(stats.promptTokens, 0);
    assert.equal(stats.completionTokens, 0);
    assert.equal(stats.tokenBudgetUsed, 0);
  });
});

// ── getInvestigatorStats ─────────────────────────────────────────────────────

describe('getInvestigatorStats', () => {
  beforeEach(() => {
    _setTestConfig({ evolve: { investigator: { enabled: true } } });
    resetInvestigator();
  });

  afterEach(() => {
    resetInvestigator();
    invalidateConfigCache();
  });

  it('returns all expected keys', () => {
    const stats = getInvestigatorStats();
    assert.ok('investigations' in stats);
    assert.ok('healed' in stats);
    assert.ok('promptTokens' in stats);
    assert.ok('completionTokens' in stats);
    assert.ok('tokenBudgetUsed' in stats);
    assert.ok('tokenBudgetMax' in stats);
  });

  it('returns zeroed counters initially', () => {
    const stats = getInvestigatorStats();
    assert.equal(stats.investigations, 0);
    assert.equal(stats.healed, 0);
    assert.equal(stats.promptTokens, 0);
    assert.equal(stats.completionTokens, 0);
    assert.equal(stats.tokenBudgetUsed, 0);
  });

  it('tokenBudgetMax is a positive number', () => {
    const stats = getInvestigatorStats();
    assert.ok(stats.tokenBudgetMax > 0);
  });
});

// ── isInvestigatorAvailable ──────────────────────────────────────────────────

describe('isInvestigatorAvailable', () => {
  const origKey = process.env['OPENAI_API_KEY'];

  beforeEach(() => {
    resetInvestigator();
  });

  afterEach(() => {
    resetInvestigator();
    invalidateConfigCache();
    if (origKey === undefined) {
      delete process.env['OPENAI_API_KEY'];
    } else {
      process.env['OPENAI_API_KEY'] = origKey;
    }
  });

  it('returns false when disabled in config', () => {
    _setTestConfig({ evolve: { investigator: { enabled: false } } });
    process.env['OPENAI_API_KEY'] = 'test-key';
    assert.equal(isInvestigatorAvailable(), false);
  });

  it('returns false when OPENAI_API_KEY is missing', () => {
    _setTestConfig({ evolve: { investigator: { enabled: true } } });
    delete process.env['OPENAI_API_KEY'];
    assert.equal(isInvestigatorAvailable(), false);
  });

  it('returns true when enabled and API key is set', () => {
    _setTestConfig({ evolve: { investigator: { enabled: true } } });
    process.env['OPENAI_API_KEY'] = 'test-key';
    assert.equal(isInvestigatorAvailable(), true);
  });
});
