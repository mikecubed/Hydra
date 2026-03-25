/**
 * Tests for hydra-models.ts — model discovery / fetchModels
 *
 * NOTE: `claude` and `gemini` CLIs are present in this environment, so we ONLY
 * test the path that returns immediately — unknown agent names — which bypass
 * all API and CLI strategies. This keeps tests fast and deterministic.
 *
 * We also verify the return-shape contract is honoured for one unknown-agent
 * call, confirming the fast-exit path returns the correct shape without error.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fetchModels, parseModelLines } from '../lib/hydra-models.ts';

// ── fetchModels — unknown agent (fast path) ───────────────────────────────────

describe('fetchModels — unknown agent name', () => {
  it('returns empty models array for a completely unrecognised agent', async () => {
    const result = await fetchModels('totally-unknown-agent-xyz');
    assert.deepEqual(result.models, []);
  });

  it('returns source "none" for a completely unrecognised agent', async () => {
    const result = await fetchModels('totally-unknown-agent-xyz');
    assert.equal(result.source, 'none');
  });

  it('handles empty-string agent name without throwing', async () => {
    const result = await fetchModels('');
    assert.deepEqual(result.models, []);
    assert.equal(result.source, 'none');
  });

  it('handles numeric-string agent name without throwing', async () => {
    const result = await fetchModels('123');
    assert.deepEqual(result.models, []);
    assert.equal(result.source, 'none');
  });

  it('handles agent name with special characters without throwing', async () => {
    const result = await fetchModels('agent/with/slashes');
    assert.deepEqual(result.models, []);
    assert.equal(result.source, 'none');
  });

  it('always returns a plain object with models array and source string', async () => {
    const result = await fetchModels('nonexistent');
    assert.ok(typeof result === 'object');
    assert.ok(Array.isArray(result.models));
    assert.ok(typeof result.source === 'string');
  });

  it('returns the same shape for every call (idempotent on unknown agent)', async () => {
    const r1 = await fetchModels('no-such-agent');
    const r2 = await fetchModels('no-such-agent');
    assert.deepEqual(r1, r2);
  });
});

// ── parseModelLines ──────────────────────────────────────────────────────────

describe('parseModelLines', () => {
  it('returns null for null input', () => {
    assert.equal(parseModelLines(null), null);
  });

  it('returns null for undefined input', () => {
    assert.equal(parseModelLines(), null);
  });

  it('returns null for empty string', () => {
    assert.equal(parseModelLines(''), null);
  });

  it('parses simple one-per-line model IDs', () => {
    const raw = 'claude-3-opus\nclaude-3-sonnet\nclaude-3-haiku\n';
    const result = parseModelLines(raw);
    assert.ok(result !== null);
    assert.ok(result.length === 3);
    assert.ok(result.includes('claude-3-haiku'));
    assert.ok(result.includes('claude-3-opus'));
    assert.ok(result.includes('claude-3-sonnet'));
  });

  it('filters out comment lines starting with #', () => {
    const raw = '# Models\nclaude-3-opus\n# Another comment\nclaude-3-haiku\n';
    const result = parseModelLines(raw);
    assert.ok(result !== null);
    assert.equal(result.length, 2);
  });

  it('filters out lines starting with -', () => {
    const raw = '- list item\nclaude-3-opus\n- another item\n';
    const result = parseModelLines(raw);
    assert.ok(result !== null);
    assert.equal(result.length, 1);
    assert.equal(result[0], 'claude-3-opus');
  });

  it('filters out lines starting with *', () => {
    const raw = '* bullet\nclaude-3-opus\n';
    const result = parseModelLines(raw);
    assert.ok(result !== null);
    assert.equal(result.length, 1);
  });

  it('filters out lines with spaces (not valid model IDs)', () => {
    const raw = 'claude-3-opus\nThis is a sentence with spaces\ngpt-4o\n';
    const result = parseModelLines(raw);
    assert.ok(result !== null);
    assert.equal(result.length, 2);
    assert.ok(result.includes('claude-3-opus'));
    assert.ok(result.includes('gpt-4o'));
  });

  it('filters out lines starting with Loaded or Hook', () => {
    const raw = 'Loaded config from ~/.config\nHook registered\nclaude-3-opus\n';
    const result = parseModelLines(raw);
    assert.ok(result !== null);
    assert.equal(result.length, 1);
    assert.equal(result[0], 'claude-3-opus');
  });

  it('filters out lines not starting with lowercase letter or digit', () => {
    const raw = 'claude-3-opus\nClaude-3-opus\n_private-model\n3.5-turbo\n';
    const result = parseModelLines(raw);
    assert.ok(result !== null);
    // 'claude-3-opus' starts with lowercase, '3.5-turbo' starts with digit — both valid
    // 'Claude-3-opus' starts with uppercase — filtered
    // '_private-model' starts with _ — filtered
    assert.ok(result.includes('claude-3-opus'));
    assert.ok(result.includes('3.5-turbo'));
    assert.ok(!result.includes('Claude-3-opus'));
    assert.ok(!result.includes('_private-model'));
  });

  it('trims whitespace from lines', () => {
    const raw = '  claude-3-opus  \n  gpt-4o  \n';
    const result = parseModelLines(raw);
    assert.ok(result !== null);
    assert.ok(result.includes('claude-3-opus'));
    assert.ok(result.includes('gpt-4o'));
  });

  it('returns sorted results', () => {
    const raw = 'gpt-4o\nclaude-3-opus\naaa-model\n';
    const result = parseModelLines(raw);
    assert.ok(result !== null);
    assert.equal(result[0], 'aaa-model');
    assert.equal(result[1], 'claude-3-opus');
    assert.equal(result[2], 'gpt-4o');
  });

  it('returns null when all lines are filtered out', () => {
    const raw = '# All comments\n- list item\n* bullet\nLoaded config\n';
    const result = parseModelLines(raw);
    assert.equal(result, null);
  });

  it('handles mixed valid and invalid lines', () => {
    const raw = [
      '# Model listing',
      'Loaded config from file',
      'claude-3-opus-20240229',
      'Hook installed',
      '  ',
      'gemini-1.5-pro',
      'This line has spaces so filtered',
      '* markdown bullet',
      'gpt-4-turbo-2024-04-09',
      '',
    ].join('\n');
    const result = parseModelLines(raw);
    assert.ok(result !== null);
    assert.equal(result.length, 3);
    assert.ok(result.includes('claude-3-opus-20240229'));
    assert.ok(result.includes('gemini-1.5-pro'));
    assert.ok(result.includes('gpt-4-turbo-2024-04-09'));
  });

  it('handles single valid line', () => {
    const result = parseModelLines('gpt-4o');
    assert.ok(result !== null);
    assert.equal(result.length, 1);
    assert.equal(result[0], 'gpt-4o');
  });
});

// ── fetchModels — return shape contract (unknown agents only) ─────────────────

describe('fetchModels — return shape contract', () => {
  const unknownAgents = ['noop', 'fake-agent-a', 'fake-agent-b'];

  for (const agent of unknownAgents) {
    it(`fetchModels("${agent}") returns { models: string[], source: string }`, async () => {
      const result = await fetchModels(agent);
      assert.ok(Array.isArray(result.models));
      assert.ok(typeof result.source === 'string');
      for (const m of result.models) {
        assert.ok(typeof m === 'string', `model entry must be string, got ${typeof m}`);
      }
    });
  }
});
